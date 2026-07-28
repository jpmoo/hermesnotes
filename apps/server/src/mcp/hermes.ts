import { userLocalNow, type Condition, type FilterGroup } from "@hermes/shared";
import type { Api } from "./api.js";

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

export function fmtDate(v: string): string {
  return v.includes("T") ? v.replace("T", " ") : v;
}

const pad = (n: number) => String(n).padStart(2, "0");
const todayStr = (tz: string | null) => {
  const d = userLocalNow(tz);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** One-line task summary: [status] Title — due …, id. */
export function fmtTaskLine(ctx: Ctx, b: HermesBlock): string {
  const p = b.properties as Record<string, unknown>;
  const span = (p[ctx.spanKey] ?? {}) as { start?: string; end?: string };
  const status = String(p[ctx.statusKey] ?? "");
  const bits: string[] = [];
  if (span.end) {
    const overdue =
      !ctx.completeValues.includes(status) && span.end.slice(0, 10) < todayStr(ctx.timezone) ? " OVERDUE" : "";
    bits.push(`due ${fmtDate(span.end)}${overdue}`);
  }
  if (span.start) bits.push(`from ${fmtDate(span.start)}`);
  return `[${status || "—"}] ${String(p.title ?? "Untitled")}${bits.length ? ` — ${bits.join(", ")}` : ""} (${b.id})`;
}
