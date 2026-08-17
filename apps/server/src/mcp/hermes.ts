import { userLocalNow, type Condition, type FilterGroup, bodyFieldKey, type PropertySchema } from "@hermes/shared";
import type { Api } from "./api.js";
import { effectiveTimeZone } from "../lib/timezone.js";

/**
 * Introspected shape of the user's task/project types. Types are user-editable,
 * so nothing is hardcoded beyond sensible name-based resolution: the builtin
 * "task" type (status + datespan) and a type named "project" (user-created),
 * linked by whatever reference field on the task type points at it.
 */
export interface Ctx {
  taskTypeId: string;
  spanKey: string; // the task's datespan property (Available/Due)
  statusKey: string;
  statusOptions: string[];
  completeValues: string[];
  projectTypeId: string;
  personTypeId: string | null; // type named "person", for @-mention auto-create
  projectRefKey: string | null; // reference field on task pointing at project
  /**
   * Where a task's / project's prose lives. Derived like every other key here,
   * because "description" is only the name the built-in types happen to use —
   * a renamed or hand-built type calls it something else, and writing to the
   * wrong key put the text somewhere the app never reads. Null when the type has
   * no long-text field at all, which is worth refusing rather than guessing.
   */
  notesKey: string | null;
  projectNotesKey: string | null;
  projectStatusKey: string | null;
  projectArchivedValue: string | null;
  projectDefaultStatus: string | null;
  timezone: string | null; // user's IANA zone, for the OVERDUE cutoff (null = server local)
}

interface FieldDef {
  key: string;
  type: string;
  options?: string[];
  refTypeId?: string;
}
interface BlockType {
  id: string;
  name: string;
  builtin: boolean;
  isText: boolean;
  propertySchema: {
    fields: FieldDef[];
    status_field?: string;
    complete_values?: string[];
    default_value?: string;
  } | null;
}
export interface HermesBlock {
  id: string;
  blockTypeId: string | null;
  properties: unknown;
  version: number;
}

const cache = new Map<string, { ctx: Ctx; at: number }>();

export async function loadContext(api: Api): Promise<Ctx> {
  const hit = cache.get(api.cacheKey);
  if (hit && Date.now() - hit.at < 60_000) return hit.ctx;
  const types = await api.get<BlockType[]>("/block-types");
  const lower = (s: string) => s.trim().toLowerCase();

  const task =
    types.find((t) => t.builtin && lower(t.name) === "task") ??
    types.find(
      (t) => t.propertySchema?.status_field && t.propertySchema.fields.some((f) => f.type === "datespan"),
    );
  if (!task?.propertySchema) throw new Error("No task type found (builtin 'task' with status + datespan).");
  const schema = task.propertySchema;
  const statusKey = schema.status_field ?? "status";
  const statusField = schema.fields.find((f) => f.key === statusKey);
  const span = schema.fields.find((f) => f.type === "datespan");
  if (!span) throw new Error("Task type has no datespan field.");

  const project = types.find((t) => lower(t.name) === "project");
  if (!project) throw new Error("No type named 'project' exists. Create one in the app first.");
  const person = types.find((t) => lower(t.name) === "person");

  // The user's timezone drives the OVERDUE cutoff, so it matches the calendar
  // day the query filter (userLocalNow) resolves against. Best-effort: a missing
  // settings row just falls back to server-local.
  const timezone = await api
    .get<{ timezone: string | null }>("/settings")
    .then((s) => s.timezone)
    .catch(() => null);

  const refField = schema.fields.find((f) => f.type === "reference" && f.refTypeId === project.id);

  // The body field, by the names the built-ins use first, then by type — so a
  // type with one long-text field called "Notes" or "Detail" still works.
  const bodyKey = (fields: FieldDef[] | undefined): string | null =>
    bodyFieldKey({ fields: (fields ?? []) as PropertySchema["fields"] });

  const projSchema = project.propertySchema;
  const projStatusKey = projSchema?.status_field ?? null;
  const projStatusField = projStatusKey ? projSchema?.fields.find((f) => f.key === projStatusKey) : null;
  const archivedOpt = projStatusField?.options?.find((o) => o.toLowerCase() === "archived") ?? null;

  const ctx: Ctx = {
    taskTypeId: task.id,
    spanKey: span.key,
    statusKey,
    statusOptions: statusField?.options ?? [],
    completeValues: schema.complete_values ?? [],
    projectTypeId: project.id,
    personTypeId: person?.id ?? null,
    projectRefKey: refField?.key ?? null,
    notesKey: bodyKey(schema.fields),
    projectNotesKey: bodyKey(projSchema?.fields),
    projectStatusKey: archivedOpt ? projStatusKey : null,
    projectArchivedValue: archivedOpt,
    projectDefaultStatus: projSchema?.default_value ?? null,
    timezone,
  };
  cache.set(api.cacheKey, { ctx, at: Date.now() });
  return ctx;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve an id-or-title to one block of the given type; error when ambiguous.
 * With `orCreate`, a name that matches nothing creates the block instead. */
async function resolveByTitle(
  api: Api,
  typeId: string,
  ident: string,
  what: string,
  orCreate = false,
): Promise<HermesBlock> {
  if (UUID_RE.test(ident.trim())) return api.get<HermesBlock>(`/blocks/${ident.trim()}`);
  const filterQuery: FilterGroup = {
    kind: "group",
    match: "all",
    items: [
      { kind: "blockType", typeId } as Condition,
      { kind: "property", key: "title", op: "contains", value: ident.trim() } as Condition,
    ],
  };
  const matches = await api.post<HermesBlock[]>("/blocks/query", { filterQuery });
  const titleOf = (b: HermesBlock) => String((b.properties as Record<string, unknown>).title ?? "");
  const exact = matches.filter((b) => titleOf(b).toLowerCase() === ident.trim().toLowerCase());
  const pool = exact.length ? exact : matches;
  if (pool.length === 1) return pool[0]!;
  if (pool.length === 0) {
    if (orCreate)
      return api.post<HermesBlock>("/blocks", {
        blockTypeId: typeId,
        properties: { title: ident.trim() },
      });
    throw new Error(`No ${what} matching "${ident}".`);
  }
  throw new Error(
    `"${ident}" matches ${pool.length} ${what}s: ${pool
      .slice(0, 6)
      .map((b) => `${titleOf(b)} (${b.id})`)
      .join("; ")}. Use the id.`,
  );
}

export const resolveTask = (api: Api, ctx: Ctx, ident: string): Promise<HermesBlock> =>
  resolveByTitle(api, ctx.taskTypeId, ident, "task");
/** Resolve a project; with `orCreate` an unknown name creates the project. */
export const resolveProject = (
  api: Api,
  ctx: Ctx,
  ident: string,
  orCreate = false,
): Promise<HermesBlock> => resolveByTitle(api, ctx.projectTypeId, ident, "project", orCreate);

/** Auto-create Person blocks for raw `@Name` mentions with no matching block.
 * Returns the names created (underscores restored to spaces). */
export async function ensurePersons(api: Api, ctx: Ctx, texts: (string | undefined)[]): Promise<string[]> {
  if (!ctx.personTypeId) return [];
  const names = new Set<string>();
  for (const t of texts) {
    if (typeof t !== "string") continue;
    const re = /(^|\s)@([A-Za-z0-9][\w-]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) if (m[2]) names.add(m[2].replace(/_/g, " "));
  }
  const created: string[] = [];
  for (const name of names) {
    // Any block with this exact title counts as the mention's target.
    const found = await api.post<HermesBlock[]>("/blocks/query", {
      filterQuery: {
        kind: "group",
        match: "all",
        items: [{ kind: "property", key: "title", op: "contains", value: name } as Condition],
      },
    });
    const exact = found.some(
      (b) => String((b.properties as Record<string, unknown>).title ?? "").toLowerCase() === name.toLowerCase(),
    );
    if (!exact) {
      await api.post("/blocks", { blockTypeId: ctx.personTypeId, properties: { title: name } });
      created.push(name);
    }
  }
  return created;
}

/**
 * The status option a caller meant.
 *
 * Statuses are the user's own — a type can call them anything — so an agent
 * asking for "completed" against a type whose word is "done" was simply refused,
 * and closing a task became an error with no way round it short of asking what
 * the options were first.
 *
 * Matched on the letters rather than the exact string, so case, spaces,
 * underscores and hyphens don't decide it. Failing that, a word that plainly
 * means finished takes the type's own complete value — which the type declares,
 * so that isn't a guess about what the user meant by it.
 */
const DONE_WORDS = new Set(["done", "complete", "completed", "finish", "finished", "closed"]);
const letters = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");

export function resolveStatus(ctx: Ctx, want: string): string | null {
  const w = letters(want);
  const exact = ctx.statusOptions.find((o) => letters(o) === w);
  if (exact) return exact;
  if (DONE_WORDS.has(w)) {
    const done = ctx.completeValues.find((v) => ctx.statusOptions.includes(v));
    if (done) return done;
  }
  return null;
}

export function fmtDate(v: string): string {
  return v.includes("T") ? v.replace("T", " ") : v;
}

const pad = (n: number) => String(n).padStart(2, "0");
const todayStr = (tz: string | null) => {
  const d = userLocalNow(effectiveTimeZone(tz));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** One-line task summary: [status] Title — due …, id. */
export function fmtTaskLine(
  ctx: Ctx,
  b: HermesBlock,
  /**
   * Project id -> title. Passed in rather than looked up here because this renders
   * one line of a list and the titles live on other blocks: resolving per line
   * would mean a request per row. Omit it where every row shares one project
   * (project_info's own task lists) and the label would just repeat.
   */
  projectNames?: Map<string, string>,
  /** The day to call things overdue against; defaults to the user's today. A
   * review of another date has to judge by that date, or every task on a past
   * day comes back marked overdue. */
  asOf?: string,
): string {
  const p = b.properties as Record<string, unknown>;
  const span = (p[ctx.spanKey] ?? {}) as { start?: string; end?: string };
  const status = String(p[ctx.statusKey] ?? "");
  const bits: string[] = [];
  if (span.end) {
    const overdue =
      !ctx.completeValues.includes(status) && span.end.slice(0, 10) < (asOf || todayStr(ctx.timezone))
        ? " OVERDUE"
        : "";
    bits.push(`due ${fmtDate(span.end)}${overdue}`);
  }
  if (span.start) bits.push(`from ${fmtDate(span.start)}`);
  // After the dates, behind a separator so a project containing a comma can't be
  // mistaken for another date bit.
  let projects = "";
  if (projectNames && ctx.projectRefKey) {
    const raw = p[ctx.projectRefKey];
    const names = (Array.isArray(raw) ? raw : [raw])
      .filter((v): v is string => typeof v === "string" && Boolean(v))
      .map((id) => projectNames.get(id) ?? id);
    if (names.length) projects = ` · ${names.join(", ")}`;
  }
  return `[${status || "—"}] ${String(p.title ?? "Untitled")}${bits.length ? ` — ${bits.join(", ")}` : ""}${projects} (${b.id})`;
}
