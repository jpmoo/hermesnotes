import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { optionLabel, type Condition, type FilterGroup, type PropertySchema } from "@hermes/shared";
import { CONFORMANCE, toInterchange } from "@hermes/interchange";
import { z } from "zod";
import { effectiveTimeZone } from "../lib/timezone.js";
import { Api, ApiError } from "./api.js";
import {
  ensurePersons,
  fmtTaskLine,
  fmtDate,
  resolveStatus,
  loadContext,
  resolveProject,
  resolveTask,
  type Ctx,
} from "./hermes.js";

/**
 * Hermes MCP toolkit: task/project/tag tools (mirroring the Spaztick MCP
 * surface), registered onto an McpServer bound to one caller's API key. The
 * key is forwarded on every internal API call, so in-app revocation cuts off
 * MCP access too.
 */

const group = (items: (Condition | FilterGroup)[], match: "all" | "any" = "all"): FilterGroup => ({
  kind: "group",
  match,
  items,
});
const prop = (key: string, op: "eq" | "neq" | "contains" | "lt" | "gt" | "empty" | "notEmpty", value?: string): Condition =>
  ({ kind: "property", key, op, value }) as Condition;

/** Conditions restricting tasks to not-complete statuses. */
function openConds(ctx: Ctx): Condition[] {
  return ctx.completeValues.map((v) => prop(ctx.statusKey, "neq", v));
}

function whenConds(ctx: Ctx, when: string): (Condition | FilterGroup)[] {
  const end = `${ctx.spanKey}.end`;
  const start = `${ctx.spanKey}.start`;
  switch (when) {
    case "overdue":
      return [prop(end, "lt", "today"), ...openConds(ctx)];
    // "Due by <day>" is cumulative: everything still open that's due that day OR
    // already overdue. `end < <the next day>` captures both, and — because a
    // datetime like `2026-07-28T09:00` sorts after the bare date `2026-07-28` —
    // comparing against the NEXT day's date also sweeps in same-day timed tasks.
    case "today":
    case "due_today":
      return [prop(end, "lt", "today+1"), ...openConds(ctx)];
    case "tomorrow":
    case "due_tomorrow":
      return [prop(end, "lt", "today+2"), ...openConds(ctx)];
    case "week":
    case "due_week":
      return [prop(end, "lt", "today+7"), ...openConds(ctx)];
    case "available":
      // Started (or starts today) — lexically start < tomorrow covers both
      // date-only and datetime forms.
      return [prop(start, "lt", "today+1"), ...openConds(ctx)];
    case "unscheduled":
      return [prop(end, "empty"), prop(start, "empty"), ...openConds(ctx)];
    default:
      throw new Error(
        `Unknown when="${when}". Use overdue, today, tomorrow, week, available, or unscheduled.`,
      );
  }
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}
export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
  /** Permanently deletes data — clients should confirm before running. */
  destructive?: boolean;
  /** Read-only (no writes) — safe to run without confirmation. */
  readOnly?: boolean;
}

/** Tool args that become URL segments/params must be shape-checked here: an
 * unvalidated string would be interpolated into a loopback request path. */
const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");
const HEX_COLOR = z.string().regex(/^#[0-9a-fA-F]{3,8}$/, "color must be a hex value like #fdf3d8");

// Archiving is reversible, so those tools aren't destructive. Only hard-deletes
// are (tags here; blocks can no longer be deleted via MCP at all).
const DESTRUCTIVE_TOOLS = new Set(["tag_delete"]);
// Properties every block can carry regardless of its type's fields.
const SYSTEM_PROP_KEYS = ["title", "banner", "icon_key", "icon_color"];
const READONLY_TOOLS = new Set([
  "search", "block_get", "list_types", "list_lists", "tag_list", "collection_members",
  "task_find", "task_info", "project_list", "project_archived", "project_info", "today_layout_get",
  // Reads a day, which brings that day's scratchpad into being if nobody has
  // opened it — the same thing today_layout_get has always done, and the same
  // thing visiting the page does. Nothing the caller had is changed by it, and
  // an untouched note is swept away again.
  "daily_note_get",
  "calendar_events",
  "daily_review",
]);

/**
 * Titles for whatever a block's reference fields point at, so they can be named
 * rather than printed as uuids. Capped: a block with hundreds of references
 * shouldn't turn one read into hundreds of requests. An id that won't resolve is
 * simply absent, and renders as the id.
 */
async function refTitleMap(
  api: Api,
  schema: PropertySchema | null | undefined,
  props: Record<string, unknown>,
): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const f of schema?.fields ?? []) {
    if (f.type !== "reference") continue;
    const v = props[f.key];
    for (const id of Array.isArray(v) ? v : [v]) {
      if (typeof id === "string" && id) ids.add(id);
    }
  }
  const out = new Map<string, string>();
  for (const id of [...ids].slice(0, 25)) {
    try {
      const target = await api.get<HermesBlock>(`/blocks/${id}`);
      const t = (target.properties as Record<string, unknown>)?.title;
      if (typeof t === "string" && t.trim()) out.set(id, t);
    } catch {
      /* unresolvable (deleted, or not ours) — the id is shown as-is */
    }
  }
  return out;
}

/**
 * Project id -> title for every project these tasks reference, in one pass. Same
 * cap and failure behaviour as refTitleMap: an id that won't resolve is rendered
 * as the id rather than dropped.
 */
async function projectNamesFor(api: Api, ctx: Ctx, tasks: HermesBlock[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ctx.projectRefKey) return out;
  const ids = new Set<string>();
  for (const task of tasks) {
    const raw = (task.properties as Record<string, unknown>)[ctx.projectRefKey];
    for (const id of Array.isArray(raw) ? raw : [raw]) {
      if (typeof id === "string" && id) ids.add(id);
    }
  }
  for (const id of [...ids].slice(0, 25)) {
    try {
      const pb = await api.get<HermesBlock>(`/blocks/${id}`);
      const title = (pb.properties as Record<string, unknown>)?.title;
      if (typeof title === "string" && title.trim()) out.set(id, title);
    } catch {
      /* unresolvable — the id is shown as-is */
    }
  }
  return out;
}

/** Every stored property the schema doesn't declare, so nothing is hidden. */
function fmtExtraProps(
  schema: PropertySchema | null | undefined,
  props: Record<string, unknown>,
  skip: string[] = [],
): string[] {
  const known = new Set([...(schema?.fields ?? []).map((f) => f.key), "title", ...skip]);
  return Object.entries(props)
    .filter(([k, v]) => !known.has(k) && v != null && v !== "")
    .map(([k, v]) => `- ${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
}

/**
 * Render a block's schema-defined fields the way a reader sees them: the field's
 * LABEL rather than its storage key, a select's option label rather than the value
 * stored underneath, a number's unit alongside it, and a reference named rather
 * than shown as a uuid.
 *
 * An empty number renders as "-" rather than being dropped, so an unset number is
 * visibly unset and can never be read back as zero.
 */
function fmtSchemaFields(
  schema: PropertySchema | null | undefined,
  props: Record<string, unknown>,
  skip: string[] = [],
  /** id -> title, for naming whatever a reference field points at. */
  refTitles: Map<string, string> = new Map(),
): string[] {
  const out: string[] = [];
  for (const f of [...(schema?.fields ?? [])].sort((x, y) => x.order - y.order)) {
    if (f.key === "title" || skip.includes(f.key)) continue;
    const raw = props[f.key];
    const label = f.label?.trim() || f.key.replace(/_/g, " ");
    if (f.type === "number") {
      const n = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
      out.push(`- ${label}: ${n === null ? "-" : n}${f.units ? ` ${f.units}` : ""}`);
      continue;
    }
    if (raw == null || raw === "") continue;
    if ((f.type === "select" || f.type === "status") && typeof raw === "string") {
      out.push(`- ${label}: ${optionLabel(f, raw)}`);
      continue;
    }
    if (f.type === "reference") {
      // Without this a reference reads as a JSON array of uuids — true, and
      // useless to anything trying to answer a question about the block.
      const ids = (Array.isArray(raw) ? raw : [raw]).filter((v): v is string => typeof v === "string");
      if (!ids.length) continue;
      out.push(`- ${label}: ${ids.map((id) => refTitles.get(id) ?? id).join(", ")}`);
      continue;
    }
    out.push(`- ${label}: ${typeof raw === "object" ? JSON.stringify(raw) : String(raw)}`);
  }
  return out;
}

/**
 * The full Hermes tool surface, bound to one caller's API client. This registry
 * is transport-agnostic: the MCP adapter (`buildTools`) exposes it to external
 * agents, and the in-app assistant invokes the same handlers in-process. Define
 * every capability here exactly once.
 */
export async function defineTools(api: Api): Promise<ToolDef[]> {
  /**
   * The statuses this user's task type actually declares, named in the
   * descriptions of the tools that take one.
   *
   * Described in the abstract, an agent has to guess a word and find out by
   * being refused — which is how "completed" arrived at a type whose word is
   * "done". Naming them costs one context load per session (cached for a
   * minute, and every tool call loads it anyway), and turns a guess into
   * reading. A user with no task type gets the general wording, since there's
   * nothing to name.
   */
  let statuses = "";
  try {
    const ctx = await loadContext(api);
    if (ctx.statusOptions.length) statuses = ` Statuses on this account: ${ctx.statusOptions.join(", ")}.`;
  } catch {
    /* no task type configured: leave the descriptions general */
  }
  const tools: ToolDef[] = [];
  // Generic so each handler's `args` is inferred from its zod schema (as the MCP
  // SDK did); stored type-erased in the registry.
  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    schema: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>,
  ) => {
    tools.push({ name, description, schema, handler: handler as (a: Record<string, unknown>) => Promise<ToolResult> });
  };
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
  const run = <A>(fn: (args: A) => Promise<string>) => {
    return async (args: A) => {
      try {
        return text(await fn(args));
      } catch (e) {
        const msg = e instanceof ApiError ? `Hermes API error ${e.status}: ${e.body}` : String(e instanceof Error ? e.message : e);
        return { ...text(msg), isError: true };
      }
    };
  };

  // ---------- tasks ----------

  tool(
    "task_create",
    `Create a task. Dates are YYYY-MM-DD (optionally with THH:mm).${statuses} project/projects accept a project title or id — unknown names create the project. Tags are created as needed, and raw @Name mentions in the title/notes create Person blocks if missing.`,
    {
      title: z.string().min(1),
      notes: z.string().optional(),
      available_date: z.string().optional(),
      due_date: z.string().optional(),
      /** The same two in the words the task profile uses. */
      start: z.string().optional(),
      due: z.string().optional(),
      status: z.string().optional(),
      project: z.string().optional(),
      projects: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
    },
    run(async (a) => {
      const ctx = await loadContext(api);
      const properties: Record<string, unknown> = { title: a.title };
      if (a.notes) {
        if (!ctx.notesKey)
          throw new Error("The task type has no long-text field, so there's nowhere to put notes.");
        properties[ctx.notesKey] = a.notes;
      }
      const availableOn = a.available_date ?? (a as { start?: string }).start;
      const dueOn = a.due_date ?? (a as { due?: string }).due;
      if (availableOn || dueOn)
        properties[ctx.spanKey] = {
          ...(availableOn ? { start: availableOn } : {}),
          ...(dueOn ? { end: dueOn } : {}),
        };
      if (a.status) {
        const status = resolveStatus(ctx, a.status);
        if (!status)
          throw new Error(`Unknown status "${a.status}". Options: ${ctx.statusOptions.join(", ")}`);
        properties[ctx.statusKey] = a.status;
      }
      const wanted = [...(a.projects ?? []), ...(a.project ? [a.project] : [])];
      if (wanted.length) {
        if (!ctx.projectRefKey)
          throw new Error("The task type has no project reference field, so tasks can't be linked to projects yet.");
        const ids: string[] = [];
        for (const p of wanted) ids.push((await resolveProject(api, ctx, p, true)).id);
        properties[ctx.projectRefKey] = ids;
      }
      const b = await api.post<{ id: string }>("/blocks", { blockTypeId: ctx.taskTypeId, properties });
      if (a.tags?.length)
        await api.put(`/blocks/${b.id}/tags`, { tags: a.tags.map((t) => t.trim().toLowerCase().replace(/^#+/, "")) });
      const people = await ensurePersons(api, ctx, [a.title, a.notes]);
      return `Created task "${a.title}" (${b.id}).${people.length ? ` Created person${people.length === 1 ? "" : "s"}: ${people.join(", ")}.` : ""}`;
    }),
  );

  tool(
    "task_find",
    `List/search tasks. All params optional and composable.${statuses} status takes any of those, or "open" for everything unfinished (comma-separated for several); when: overdue|today|tomorrow|week|available|unscheduled; term: text search; project: title or id; list: a saved collection's title or id; region: a matrix region/row/column title within that list (e.g. "Do").`,
    {
      status: z.string().optional(),
      when: z.string().optional(),
      term: z.string().optional(),
      tag: z.string().optional(),
      tags: z.array(z.string()).optional(),
      project: z.string().optional(),
      list: z.string().optional(),
      region: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    run(async (a) => {
      const ctx = await loadContext(api);

      const otherFilters = Boolean(a.status || a.when || a.term || a.tag || a.tags?.length || a.project);
      // Ids restricted by collection membership (and matrix region), when asked.
      let scopeIds: Set<string> | null = null;
      let scopeLabel = "";
      if (a.list) {
        const cols = await api.get<{ id: string; properties: Record<string, unknown> }[]>("/collections");
        const needle = a.list.trim().toLowerCase();
        const col =
          cols.find((c) => c.id === a.list) ??
          cols.find((c) => String(c.properties.title ?? "").toLowerCase() === needle) ??
          cols.find((c) => String(c.properties.title ?? "").toLowerCase().includes(needle));
        if (!col) throw new Error(`No collection matching "${a.list}".`);
        scopeLabel = String(col.properties.title ?? "collection");
        const d = await api.get<{
          collection: { collectionKind: string | null; properties: Record<string, unknown> };
          members: (HermesBlock & { context?: Record<string, unknown> })[];
        }>(`/collections/${col.id}`);
        const cprops = d.collection.properties;
        const isMatrix = d.collection.collectionKind === "matrix";
        const isSmart = cprops.membership_mode === "smart";
        const bindKey = typeof cprops.matrix_bind_property === "string" ? cprops.matrix_bind_property : "";

        // The cards the board actually shows are those matching the collection's
        // query — a placed card the query no longer matches (e.g. a completed
        // task) is hidden even though its membership row stays.
        const matched =
          cprops.filter_query != null
            ? await api.post<HermesBlock[]>("/blocks/query", { filterQuery: cprops.filter_query })
            : [];
        const liveIds = new Set(matched.map((b) => b.id));
        // Bound/date matrices place live matches by value; others use memberships.
        let pool: (HermesBlock & { context?: Record<string, unknown> })[] =
          isMatrix && isSmart && bindKey ? matched : d.members;

        if (a.region) {
          if (!isMatrix) throw new Error(`"${scopeLabel}" is not a matrix — region only applies to matrices.`);
          const rl = a.region.trim().toLowerCase();
          const titled = (defs: unknown): number[] =>
            (Array.isArray(defs) ? (defs as { title?: string }[]) : [])
              .map((r, i) => ({ i, t: String(r?.title ?? "").trim().toLowerCase() }))
              .filter((x) => x.t === rl)
              .map((x) => x.i);
          if (bindKey && bindKey.startsWith("@")) {
            // Date mode: regions are row bands (matrix_date_rows + matrix_lanes).
            const rows = titled(cprops.matrix_date_rows);
            if (!rows.length) throw new Error(`No row titled "${a.region}" in "${scopeLabel}".`);
            const lanes = (cprops.matrix_lanes && typeof cprops.matrix_lanes === "object"
              ? cprops.matrix_lanes
              : {}) as Record<string, number>;
            const rowOf = (id: string) => (Number.isInteger(lanes[id]) && lanes[id]! >= 0 ? lanes[id]! : 0);
            pool = pool.filter((b) => rows.includes(rowOf(b.id)));
          } else if (bindKey) {
            // Status-bound: the region IS a status option.
            pool = pool.filter(
              (b) => String((b.properties as Record<string, unknown>)?.[bindKey] ?? "").toLowerCase() === rl,
            );
          } else {
            // Custom grid: placement lives in membership context.region.
            const idxs = titled(cprops.matrix_regions);
            if (!idxs.length) throw new Error(`No region titled "${a.region}" in "${scopeLabel}".`);
            pool = pool.filter((m) => {
              const member = d.members.find((x) => x.id === m.id);
              const r = Number(member?.context?.region);
              return Number.isInteger(r) && idxs.includes(r);
            });
          }
          scopeLabel += ` › ${a.region}`;
        }
        // Mirror the board: drop placements the collection's query no longer
        // matches (so region results never include e.g. completed tasks).
        if (isMatrix && cprops.filter_query != null) pool = pool.filter((m) => liveIds.has(m.id));
        scopeIds = new Set(pool.filter((m) => m.blockTypeId === ctx.taskTypeId).map((m) => m.id));
        if (!scopeIds.size) return `No tasks in "${scopeLabel}".`;
        if (!otherFilters) {
          const tasks = pool.filter((m) => scopeIds!.has(m.id));
          const limit = a.limit ?? 50;
          const shownTasks = tasks.slice(0, limit);
          const names = await projectNamesFor(api, ctx, shownTasks);
          return shownTasks.map((b) => fmtTaskLine(ctx, b, names)).join("\n");
        }
      } else if (a.region) {
        throw new Error("region requires list (the matrix collection to look in).");
      }

      const items: (Condition | FilterGroup)[] = [
        { kind: "blockType", typeId: ctx.taskTypeId } as Condition,
      ];
      if (a.status) {
        const wanted = a.status.split(",").map((s) => s.trim()).filter(Boolean);
        if (wanted.length === 1 && wanted[0] === "open") items.push(...openConds(ctx));
        else
          items.push(
            group(
              wanted.map((s) => {
                const resolved = resolveStatus(ctx, s);
                if (!resolved)
                  throw new Error(`Unknown status "${s}". Options: open, ${ctx.statusOptions.join(", ")}`);
                return prop(ctx.statusKey, "eq", resolved);
              }),
              "any",
            ),
          );
      }
      if (a.when) items.push(...whenConds(ctx, a.when));
      if (a.term) items.push({ kind: "text", value: a.term } as Condition);
      for (const t of [...(a.tags ?? []), ...(a.tag ? [a.tag] : [])])
        items.push({ kind: "tag", tag: t.trim().toLowerCase().replace(/^#+/, "") } as Condition);
      if (a.project) {
        if (!ctx.projectRefKey) throw new Error("The task type has no project reference field.");
        const p = await resolveProject(api, ctx, a.project);
        items.push(prop(ctx.projectRefKey, "contains", p.id));
      }
      let blocks = await api.post<HermesBlock[]>("/blocks/query", { filterQuery: group(items) });
      if (scopeIds) blocks = blocks.filter((b) => scopeIds!.has(b.id));
      const limit = a.limit ?? 50;
      if (!blocks.length) return scopeLabel ? `No matching tasks in "${scopeLabel}".` : "No matching tasks.";
      const shown = blocks.slice(0, limit);
      const names = await projectNamesFor(api, ctx, shown);
      const lines = shown.map((b) => fmtTaskLine(ctx, b, names));
      const more = blocks.length > limit ? `\n…and ${blocks.length - limit} more (raise limit to see them).` : "";
      return lines.join("\n") + more;
    }),
  );

  tool(
    "task_info",
    "Get full details for one task by id or (unique) title. Prefer this over block_get for " +
      "tasks: it accepts a title (block_get needs a uuid) and answers in task terms — status, " +
      "available/due, projects. block_get reads anything, tasks included.",
    { task: z.string().min(1) },
    run(async (a) => {
      const ctx = await loadContext(api);
      const b = await resolveTask(api, ctx, a.task);
      const info = await api.get<{ tags: { name: string }[]; inCollections: { id: string; label: string }[] }>(
        `/blocks/${b.id}/info`,
      );
      const p = b.properties as Record<string, unknown>;
      const span = (p[ctx.spanKey] ?? {}) as { start?: string; end?: string };
      // The task type's own schema, so a field somebody added to it — "duration",
      // "energy", whatever — is reported rather than quietly dropped. Anything
      // this tool already spells out in task terms is skipped below, so nothing
      // appears twice.
      const types = await api.get<{ id: string; propertySchema: PropertySchema | null }[]>(
        "/block-types",
      );
      const schema = types.find((t) => t.id === ctx.taskTypeId)?.propertySchema ?? null;
      const refTitles = await refTitleMap(api, schema, p);

      const out = [
        `Task: ${String(p.title ?? "Untitled")}`,
        `Id: ${b.id}`,
        `Status: ${String(p[ctx.statusKey] ?? "—")}`,
        span.start ? `Available: ${fmtDate(span.start)}` : null,
        span.end ? `Due: ${fmtDate(span.end)}` : null,
        info.tags.length ? `Tags: ${info.tags.map((t) => `#${t.name}`).join(" ")}` : null,
        info.inCollections.length ? `Collections: ${info.inCollections.map((c) => c.label).join(", ")}` : null,
      ].filter(Boolean) as string[];

      if (ctx.projectRefKey && Array.isArray(p[ctx.projectRefKey]) && (p[ctx.projectRefKey] as string[]).length) {
        const names = (p[ctx.projectRefKey] as string[]).map((id) => refTitles.get(id) ?? id);
        out.splice(3, 0, `Projects: ${names.join(", ")}`);
      }

      const shown = [
        ctx.statusKey,
        ctx.spanKey,
        ...(ctx.notesKey ? [ctx.notesKey] : []),
        ...(ctx.projectRefKey ? [ctx.projectRefKey] : []),
      ];
      const rest = [
        ...fmtSchemaFields(schema, p, shown, refTitles),
        ...fmtExtraProps(schema, p, shown),
      ];
      if (rest.length) out.push("", "Fields:", ...rest);

      // Long-form last, so the scannable facts aren't buried under it.
      const taskNotes = ctx.notesKey ? p[ctx.notesKey] : null;
      if (taskNotes) out.push("", `Notes:\n${String(taskNotes)}`);
      return out.join("\n");
    }),
  );

  tool(
    "task_update",
    `Update a task by id or title. Only supplied fields change.${statuses} Case and spacing in a status don't matter, and "completed"/"finished" land on whichever of them means done. Empty string clears a date. add/remove_tags and add/remove_projects adjust without replacing; unknown project names and new tags are created, and raw @Name mentions create Person blocks if missing.`,
    {
      task: z.string().min(1),
      title: z.string().optional(),
      notes: z.string().optional(),
      status: z.string().optional(),
      available_date: z.string().optional(),
      due_date: z.string().optional(),
      // The same two, in the words the task profile uses. A caller that knows
      // the shared vocabulary and nothing about Hermes should not have to guess
      // that "due" is spelled "due_date" here.
      start: z.string().optional(),
      due: z.string().optional(),
      add_tags: z.array(z.string()).optional(),
      remove_tags: z.array(z.string()).optional(),
      add_projects: z.array(z.string()).optional(),
      remove_projects: z.array(z.string()).optional(),
    },
    run(async (a) => {
      const ctx = await loadContext(api);
      const b = await resolveTask(api, ctx, a.task);
      const p = { ...(b.properties as Record<string, unknown>) };
      const changed: string[] = [];
      if (a.title !== undefined) {
        p.title = a.title;
        changed.push("title");
      }
      if (a.notes !== undefined) {
        if (!ctx.notesKey)
          throw new Error("The task type has no long-text field, so there's nowhere to put notes.");
        p[ctx.notesKey] = a.notes;
        changed.push("notes");
      }
      if (a.status !== undefined) {
        const status = resolveStatus(ctx, a.status);
        if (!status)
          throw new Error(`Unknown status "${a.status}". Options: ${ctx.statusOptions.join(", ")}`);
        p[ctx.statusKey] = status;
        changed.push(`status → ${status}`);
      }
      const availableOn = a.available_date ?? (a as { start?: string }).start;
      const dueOn = a.due_date ?? (a as { due?: string }).due;
      if (availableOn !== undefined || dueOn !== undefined) {
        const span = { ...((p[ctx.spanKey] ?? {}) as { start?: string; end?: string }) };
        if (availableOn !== undefined) span.start = availableOn || undefined;
        if (dueOn !== undefined) span.end = dueOn || undefined;
        p[ctx.spanKey] = span;
        changed.push("schedule");
      }
      if (a.add_projects?.length || a.remove_projects?.length) {
        if (!ctx.projectRefKey) throw new Error("The task type has no project reference field.");
        let refs = Array.isArray(p[ctx.projectRefKey]) ? [...(p[ctx.projectRefKey] as string[])] : [];
        for (const name of a.add_projects ?? []) {
          const proj = await resolveProject(api, ctx, name, true);
          if (!refs.includes(proj.id)) refs.push(proj.id);
        }
        for (const name of a.remove_projects ?? []) {
          const proj = await resolveProject(api, ctx, name);
          refs = refs.filter((r) => r !== proj.id);
        }
        p[ctx.projectRefKey] = refs;
        changed.push("projects");
      }
      if (changed.length) await api.patch(`/blocks/${b.id}`, { properties: p, version: b.version });
      if (a.add_tags?.length || a.remove_tags?.length) {
        const cur = await api.get<string[]>(`/blocks/${b.id}/tags`);
        const norm = (t: string) => t.trim().toLowerCase().replace(/^#+/, "");
        let next = [...cur];
        for (const t of a.add_tags ?? []) if (!next.includes(norm(t))) next.push(norm(t));
        const drop = new Set((a.remove_tags ?? []).map(norm));
        next = next.filter((t) => !drop.has(t));
        await api.put(`/blocks/${b.id}/tags`, { tags: next });
        changed.push("tags");
      }
      const people =
        a.title !== undefined || a.notes !== undefined
          ? await ensurePersons(api, ctx, [a.title, a.notes])
          : [];
      return changed.length
        ? `Updated ${String((b.properties as Record<string, unknown>).title ?? b.id)}: ${changed.join(", ")}.${people.length ? ` Created: ${people.join(", ")}.` : ""}`
        : "Nothing to change.";
    }),
  );

  tool(
    "task_archive",
    "Archive a task: hide it from every normal view and query. Reversible — it stays exactly where it was and comes back on unarchive (block_unarchive). This replaces deletion; blocks can only be permanently deleted by the user from the Archive screen.",
    { task: z.string().min(1) },
    run(async (a) => {
      const ctx = await loadContext(api);
      const b = await resolveTask(api, ctx, a.task);
      const title = String((b.properties as Record<string, unknown>).title ?? b.id);
      await api.post(`/blocks/${b.id}/archive`, {});
      return `Archived "${title}" [${b.id}].`;
    }),
  );

  // ---------- projects ----------

  tool(
    "project_create",
    "Create a project.",
    { title: z.string().min(1), description: z.string().optional() },
    run(async (a) => {
      const ctx = await loadContext(api);
      const properties: Record<string, unknown> = { title: a.title };
      if (a.description) {
        if (!ctx.projectNotesKey)
          throw new Error("The project type has no long-text field, so there's nowhere to put a description.");
        properties[ctx.projectNotesKey] = a.description;
      }
      const b = await api.post<{ id: string }>("/blocks", { blockTypeId: ctx.projectTypeId, properties });
      return `Created project "${a.title}" (${b.id}).`;
    }),
  );

  /** Ids of projects archived via the #archived tag (used when the project
   * type has no status field with an archived option). */
  const taggedArchivedIds = async (ctx: Ctx): Promise<Set<string>> => {
    if (ctx.projectStatusKey) return new Set();
    const tagged = await api.post<HermesBlock[]>("/blocks/query", {
      filterQuery: group([
        { kind: "blockType", typeId: ctx.projectTypeId } as Condition,
        { kind: "tag", tag: "archived" } as Condition,
      ]),
    });
    return new Set(tagged.map((b) => b.id));
  };

  const projectLines = async (ctx: Ctx, archived: boolean): Promise<string> => {
    const projects = await api.get<HermesBlock[]>(`/blocks/of-type/${ctx.projectTypeId}`);
    const tagged = await taggedArchivedIds(ctx);
    const rows: string[] = [];
    for (const proj of projects) {
      if ((isArchivedProject(ctx, proj) || tagged.has(proj.id)) !== archived) continue;
      let openCount = "";
      if (ctx.projectRefKey) {
        const tasks = await api.post<HermesBlock[]>("/blocks/query", {
          filterQuery: group([
            { kind: "blockType", typeId: ctx.taskTypeId } as Condition,
            prop(ctx.projectRefKey, "contains", proj.id),
            ...openConds(ctx),
          ]),
        });
        openCount = ` — ${tasks.length} open task${tasks.length === 1 ? "" : "s"}`;
      }
      rows.push(`${String((proj.properties as Record<string, unknown>).title ?? "Untitled")}${openCount} (${proj.id})`);
    }
    return rows.length ? rows.join("\n") : archived ? "No archived projects." : "No active projects.";
  };

  tool("project_list", "List active (non-archived) projects with open-task counts.", {}, run(async () => {
    const ctx = await loadContext(api);
    return projectLines(ctx, false);
  }));

  tool("project_archived", "List archived projects.", {}, run(async () => {
    const ctx = await loadContext(api);
    return projectLines(ctx, true);
  }));

  tool(
    "project_info",
    "Get a project's details and its tasks, by id or title.",
    { project: z.string().min(1) },
    run(async (a) => {
      const ctx = await loadContext(api);
      const proj = await resolveProject(api, ctx, a.project);
      const p = proj.properties as Record<string, unknown>;
      const out = [
        `Project: ${String(p.title ?? "Untitled")}${isArchivedProject(ctx, proj) ? " (archived)" : ""}`,
        `Id: ${proj.id}`,
      ].filter(Boolean) as string[];

      // The project type's own schema, so its status and any field somebody added
      // to it are reported rather than dropped. Previously only the title, id and
      // description came through, which meant asking about anything else sent the
      // caller back for a second, deeper read.
      const types = await api.get<{ id: string; propertySchema: PropertySchema | null }[]>(
        "/block-types",
      );
      const schema = types.find((t) => t.id === ctx.projectTypeId)?.propertySchema ?? null;
      const refTitles = await refTitleMap(api, schema, p);
      const shown = ctx.projectNotesKey ? [ctx.projectNotesKey] : []; // rendered below, in full
      const rest = [
        ...fmtSchemaFields(schema, p, shown, refTitles),
        ...fmtExtraProps(schema, p, shown),
      ];
      if (rest.length) out.push("", "Fields:", ...rest);
      // Long-form after the scannable facts, and before the task lists.
      const about = ctx.projectNotesKey ? p[ctx.projectNotesKey] : null;
      if (about) out.push("", `About:\n${String(about)}`);
      if (ctx.projectRefKey) {
        const tasks = await api.post<HermesBlock[]>("/blocks/query", {
          filterQuery: group([
            { kind: "blockType", typeId: ctx.taskTypeId } as Condition,
            prop(ctx.projectRefKey, "contains", proj.id),
          ]),
        });
        const open = tasks.filter((t) => !ctx.completeValues.includes(String((t.properties as Record<string, unknown>)[ctx.statusKey] ?? "")));
        const donePile = tasks.filter((t) => !open.includes(t));
        if (open.length) out.push("", "Open tasks:", ...open.map((t) => fmtTaskLine(ctx, t)));
        if (donePile.length) out.push("", "Completed tasks:", ...donePile.map((t) => fmtTaskLine(ctx, t)));
        if (!tasks.length) out.push("", "No tasks.");
      }
      return out.join("\n");
    }),
  );

  const setArchived = async (ident: string, archived: boolean, confirm: boolean | undefined): Promise<string> => {
    const ctx = await loadContext(api);
    const proj = await resolveProject(api, ctx, ident);
    const title = String((proj.properties as Record<string, unknown>).title ?? proj.id);
    const verb = archived ? "archive" : "unarchive";
    if (!confirm) return `This will ${verb} "${title}". Call again with confirm=true.`;
    if (ctx.projectStatusKey && ctx.projectArchivedValue) {
      const p = { ...(proj.properties as Record<string, unknown>) };
      p[ctx.projectStatusKey] = archived ? ctx.projectArchivedValue : (ctx.projectDefaultStatus ?? "");
      await api.patch(`/blocks/${proj.id}`, { properties: p, version: proj.version });
    } else {
      const tags = await api.get<string[]>(`/blocks/${proj.id}/tags`);
      const next = archived ? [...new Set([...tags, "archived"])] : tags.filter((t) => t !== "archived");
      await api.put(`/blocks/${proj.id}/tags`, { tags: next });
    }
    return `${archived ? "Archived" : "Unarchived"} "${title}".`;
  };

  tool(
    "project_archive",
    "Archive a project (status if the type has an archived option, otherwise an #archived tag). Two-step confirm.",
    { project: z.string().min(1), confirm: z.boolean().optional() },
    run((a) => setArchived(a.project, true, a.confirm)),
  );
  tool(
    "project_unarchive",
    "Unarchive a project. Two-step confirm.",
    { project: z.string().min(1), confirm: z.boolean().optional() },
    run((a) => setArchived(a.project, false, a.confirm)),
  );

  // (A project is a block — archive one with block_archive. There is no
  // hard-delete tool; only the user can permanently delete, from the Archive.)

  // ---------- lists & tags ----------

  tool("list_lists", "List saved collections (usable as task_find's `list` param).", {}, run(async () => {
    const cols = await api.get<{ id: string; collectionKind: string; properties: Record<string, unknown> }[]>(
      "/collections",
    );
    if (!cols.length) return "No collections.";
    return cols
      .map((c) => {
        const smart = c.properties.membership_mode === "smart" ? "smart " : "";
        return `${String(c.properties.title ?? "Untitled")} — ${smart}${c.collectionKind} (${c.id})`;
      })
      .join("\n");
  }));

  tool("tag_list", "List all tags.", {}, run(async () => {
    const tags = await api.get<{ name: string }[]>("/tags");
    return tags.length ? tags.map((t) => `#${t.name}`).join("\n") : "No tags.";
  }));

  const retagAll = async (from: string, to: string | null): Promise<number> => {
    const blocks = await api.post<HermesBlock[]>("/blocks/query", {
      filterQuery: group([{ kind: "tag", tag: from } as Condition]),
    });
    for (const b of blocks) {
      const cur = await api.get<string[]>(`/blocks/${b.id}/tags`);
      let next = cur.filter((t) => t !== from);
      if (to && !next.includes(to)) next.push(to);
      await api.put(`/blocks/${b.id}/tags`, { tags: next });
    }
    return blocks.length;
  };

  tool(
    "tag_rename",
    "Rename a tag on every block that has it. Two-step confirm.",
    { old_tag: z.string().min(1), new_tag: z.string().min(1), confirm: z.boolean().optional() },
    run(async (a) => {
      const from = a.old_tag.trim().toLowerCase().replace(/^#+/, "");
      const to = a.new_tag.trim().toLowerCase().replace(/^#+/, "");
      if (!a.confirm) return `This will rename #${from} → #${to} everywhere. Call again with confirm=true.`;
      const r = await api.post<{ rewritten: number }>("/tags/rename", { from, to });
      return `Renamed #${from} → #${to} (tag associations moved; text mentions rewritten in ${r.rewritten} block${r.rewritten === 1 ? "" : "s"}).`;
    }),
  );

  tool(
    "tag_delete",
    "Remove a tag from every block that has it. Two-step confirm.",
    { tag: z.string().min(1), confirm: z.boolean().optional() },
    run(async (a) => {
      const t = a.tag.trim().toLowerCase().replace(/^#+/, "");
      if (!a.confirm) return `This will remove #${t} from every block. Call again with confirm=true.`;
      const n = await retagAll(t, null);
      return `Removed #${t} from ${n} block${n === 1 ? "" : "s"}.`;
    }),
  );

  // ---------- general search / read ----------

  interface SearchHit {
    id: string;
    kind: "block" | "collection" | "today";
    date?: string;
    blockTypeId: string | null;
    label: string;
    document: boolean;
    matrix: boolean;
    table: boolean;
    canvas: boolean;
    calendar: boolean;
    rollup: boolean;
    smart: boolean;
    semantic: boolean;
  }

  tool(
    "search",
    "Search EVERYTHING — every block (notes, tasks, people…) and collection — by literal match " +
      "(title, body, properties) plus semantic similarity, like the app's top-bar search. " +
      "Use this for requests like \"find my note about X\". Returns ids for block_get.",
    { query: z.string().min(1) },
    run(async (a) => {
      const hits = await api.get<SearchHit[]>(`/search?q=${encodeURIComponent(a.query)}`);
      if (!hits.length) return "No matches.";
      const types = await api.get<{ id: string; name: string }[]>("/block-types");
      const typeName = new Map(types.map((t) => [t.id, t.name]));
      const kindOf = (h: SearchHit) =>
        h.kind === "today"
          ? `daily note ${h.date ?? ""}`.trim()
          : h.kind === "collection"
            ? `${h.smart ? "smart " : ""}${
                h.document
                  ? "spread"
                  : h.matrix
                    ? "matrix"
                    : h.table
                      ? "table"
                      : h.canvas
                        ? "canvas"
                        : h.calendar
                          ? "calendar"
                          : h.rollup
                            ? "rollup"
                            : "list"
              }`
            : (h.blockTypeId && typeName.get(h.blockTypeId)) || "block";
      return hits
        .map((h) => `- ${h.label} — ${kindOf(h)}${h.semantic ? " (semantic match)" : ""} [${h.id}]`)
        .join("\n");
    }),
  );

  tool(
    "block_get",
    "Read one block or collection by id (from search): content, properties, tags, and " +
      "containing collections. Collections also list their members. " +
      'Pass as:"interchange" to get the pkm-interchange object instead of prose — readable by ' +
      "anything that knows the format and nothing about Hermes.",
    { id: z.string().uuid(), as: z.enum(["prose", "interchange"]).optional() },
    run(async (a) => {
      const b = await api.get<{
        id: string;
        blockTypeId: string | null;
        collectionKind: string | null;
        content: string | null;
        properties: Record<string, unknown>;
        createdAt: string;
        updatedAt: string;
      }>(`/blocks/${a.id}`);
      const info = await api.get<{
        tags: string[];
        inCollections: { id: string; label: string }[];
      }>(`/blocks/${a.id}/info`);

      if ((a as { as?: string }).as === "interchange") {
        const types = await api.get<
          { id: string; name: string; isText: boolean; propertySchema: PropertySchema | null }[]
        >("/block-types");
        const { envelope } = toInterchange({
          types: types.map((t) => ({ ...t, propertySchema: t.propertySchema ?? null })),
          blocks: [
            {
              id: b.id,
              blockTypeId: b.blockTypeId,
              collectionKind: b.collectionKind,
              content: b.content,
              properties: b.properties ?? {},
              archivedAt: null,
              createdAt: b.createdAt,
              updatedAt: b.updatedAt,
              tags: info.tags,
            },
          ],
          memberships: [],
        });
        const [only] = (envelope as { objects: unknown[] }).objects;
        return JSON.stringify(only ?? null, null, 2);
      }

      const lines: string[] = [];
      const title = typeof b.properties?.title === "string" ? b.properties.title : "";
      if (title) lines.push(`# ${title}`);
      if (b.collectionKind) {
        const kind = b.collectionKind === "document" ? "spread" : b.collectionKind;
        lines.push(`Collection (${kind}) [${b.id}]`);
        const d = await api.get<{
          members: { id: string; content: string | null; properties: Record<string, unknown> }[];
        }>(`/collections/${b.id}`);
        lines.push(`Members (${d.members.length}):`);
        for (const m of d.members) {
          const label =
            (typeof m.properties?.title === "string" && m.properties.title) ||
            (m.content ?? "").split("\n")[0] ||
            "Untitled";
          lines.push(`- ${label} [${m.id}]`);
        }
      } else {
        lines.push(`Block [${b.id}] created ${fmtDate(b.createdAt)}, edited ${fmtDate(b.updatedAt)}`);
        if (b.content) lines.push("", b.content);
        const types = await api.get<{ id: string; propertySchema: PropertySchema | null }[]>(
          "/block-types",
        );
        const schema = types.find((t) => t.id === b.blockTypeId)?.propertySchema ?? null;
        const refTitles = await refTitleMap(api, schema, b.properties ?? {});
        const described = fmtSchemaFields(schema, b.properties ?? {}, [], refTitles);
        // Anything the schema does not declare still gets shown, so no stored
        // value silently disappears from the model's view.
        const extra = fmtExtraProps(schema, b.properties ?? {});
        if (described.length || extra.length) {
          lines.push("", "Properties:");
          lines.push(...described, ...extra);
        }
      }
      if (info.tags.length) lines.push("", `Tags: ${info.tags.map((t) => `#${t}`).join(" ")}`);
      if (info.inCollections.length)
        lines.push(`In collections: ${info.inCollections.map((c) => `${c.label} [${c.id}]`).join(", ")}`);
      return lines.join("\n");
    }),
  );

  tool(
    "block_update",
    "Update ANY block by id (from search/block_get): note body (content), title, arbitrary " +
      "properties (shallow-merged — keys must match the block type's fields; read the block " +
      "with block_get first), and add/remove tags. Collections accept title and description. " +
      "For tasks, prefer task_update (status validation, projects, date shorthand).",
    {
      id: z.string().uuid(),
      title: z.string().optional(),
      content: z.string().optional(),
      properties: z.record(z.unknown()).optional(),
      // Removing a value has to be sayable and has to be said out loud. Making
      // an absent key mean delete would collide with the shallow merge above,
      // which is the whole point of the merge.
      unset: z.array(z.string()).optional(),
      add_tags: z.array(z.string()).optional(),
      remove_tags: z.array(z.string()).optional(),
    },
    run(async (a) => {
      const b = await api.get<HermesBlock & { collectionKind: string | null; content: string | null }>(
        `/blocks/${a.id}`,
      );
      const changed: string[] = [];

      if (b.collectionKind) {
        // Collections: properties are collection config — only expose the safe pair.
        const patch: Record<string, unknown> = {};
        if (a.title !== undefined) {
          patch.title = a.title;
          changed.push("title");
        }
        const desc = a.properties?.description;
        if (typeof desc === "string") {
          patch.description = desc;
          changed.push("description");
        }
        if (a.content !== undefined)
          throw new Error("Collections have no body content — use title/description.");
        if (Object.keys(patch).length) await api.patch(`/collections/${b.id}`, patch);
      } else {
        const p = { ...(b.properties as Record<string, unknown>) };
        const body: Record<string, unknown> = { version: b.version };
        if (a.title !== undefined) {
          p.title = a.title;
          changed.push("title");
        }
        if (a.properties) {
          // A key the type doesn't define is stored happily and shown nowhere:
          // the app renders a block from its schema, so the text is gone as far
          // as anyone can tell, while this tool reports success and block_get
          // dutifully reads it back. Refuse instead, and say what the fields
          // actually are — the caller can then write to the right one.
          const type = (
            await api.get<{ id: string; propertySchema: { fields: { key: string }[] } | null }[]>(
              "/block-types",
            )
          ).find((t) => t.id === b.blockTypeId);
          const fields = type?.propertySchema?.fields ?? null;
          if (fields) {
            const known = new Set([...fields.map((f) => f.key), ...SYSTEM_PROP_KEYS]);
            const unknown = Object.keys(a.properties).filter((k) => !known.has(k));
            if (unknown.length) {
              throw new Error(
                `This block's type has no field ${unknown.map((k) => `"${k}"`).join(", ")}. ` +
                  `Its fields are: ${fields.map((f) => f.key).join(", ")}. Nothing was written.`,
              );
            }
          }
          Object.assign(p, a.properties);
          changed.push(...Object.keys(a.properties));
        }
        for (const k of (a as { unset?: string[] }).unset ?? []) {
          delete p[k];
          changed.push(`-${k}`);
        }
        if (a.title !== undefined || a.properties || (a as { unset?: string[] }).unset?.length) {
          body.properties = p;
        }
        if (a.content !== undefined) {
          body.content = a.content;
          changed.push("content");
        }
        if (Object.keys(body).length > 1) await api.patch(`/blocks/${b.id}`, body);
      }

      if (a.add_tags?.length || a.remove_tags?.length) {
        const cur = await api.get<string[]>(`/blocks/${b.id}/tags`);
        const norm = (t: string) => t.trim().toLowerCase().replace(/^#+/, "");
        let next = [...cur];
        for (const t of a.add_tags ?? []) if (!next.includes(norm(t))) next.push(norm(t));
        const drop = new Set((a.remove_tags ?? []).map(norm));
        next = next.filter((t) => !drop.has(t));
        await api.put(`/blocks/${b.id}/tags`, { tags: next });
        changed.push("tags");
      }

      return changed.length ? `Updated [${b.id}]: ${changed.join(", ")}.` : "Nothing to change.";
    }),
  );

  // ---------- general blocks, collections, canvas ----------

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const getTypes = () =>
    api.get<{ id: string; name: string; isText: boolean }[]>("/block-types");
  const resolveType = async (name?: string) => {
    const types = await getTypes();
    if (!name || name.trim().toLowerCase() === "text") {
      const t = types.find((x) => x.isText);
      if (!t) throw new Error("No text block type found.");
      return t;
    }
    const n = name.trim().toLowerCase();
    const t = types.find((x) => x.name.toLowerCase() === n) ?? types.find((x) => x.name.toLowerCase().includes(n));
    if (!t) throw new Error(`No block type "${name}". Available: ${types.map((x) => x.name).join(", ")}.`);
    return t;
  };
  const resolveBlockId = async (idOrTitle: string): Promise<string> => {
    const s = idOrTitle.trim();
    if (UUID.test(s)) return s;
    const hits = await api.get<{ id: string; label: string }[]>(`/search?q=${encodeURIComponent(s)}`);
    if (!hits.length) throw new Error(`No block matching "${idOrTitle}".`);
    return hits[0]!.id;
  };
  const resolveCollectionId = async (idOrTitle: string): Promise<string> => {
    const s = idOrTitle.trim();
    if (UUID.test(s)) return s;
    const cols = await api.get<{ id: string; properties: Record<string, unknown> }[]>("/collections");
    const n = s.toLowerCase();
    const c =
      cols.find((x) => String(x.properties.title ?? "").toLowerCase() === n) ??
      cols.find((x) => String(x.properties.title ?? "").toLowerCase().includes(n));
    if (!c) throw new Error(`No collection matching "${idOrTitle}".`);
    return c.id;
  };

  // ---------- the interchange binding ----------
  //
  // Four tools rather than forty rewritten. Everything else here is a Hermes
  // convenience, phrased in Hermes' own words: `task_update` wants a project
  // title, `block_get` prints a block the way a person reads one. Those are good
  // tools and they are not a binding — a binding is the claim that the shared
  // vocabulary travels over this transport, and a caller who only knows the
  // vocabulary has to be able to get somewhere with it.
  //
  // So: ask what this instance honours, read the types in profile terms, read an
  // object, and write part of one. An agent that has never heard of Hermes can
  // work from those; an agent that has can carry on using everything else.

  tool(
    "interchange_conformance",
    "What this Hermes honours, as a pkm-interchange manifest: levels per role, bindings, profiles, features. Ask before writing rather than discovering by trying.",
    {},
    run(async () => JSON.stringify(CONFORMANCE, null, 2)),
  );

  tool(
    "interchange_types",
    "The block types as pkm-interchange declares them: fields with value kinds, and the profiles each type declares (task, note, and so on). This is how to find out which field carries a due date or a completion state without knowing what this account calls them.",
    {},
    run(async () => {
      const types = await api.get<{ id: string; name: string; isText: boolean; propertySchema: PropertySchema | null }[]>(
        "/block-types",
      );
      const { envelope } = toInterchange({ types: types.map((t) => ({ ...t, propertySchema: t.propertySchema ?? null })), blocks: [], memberships: [] });
      return JSON.stringify((envelope as { types: unknown[] }).types, null, 2);
    }),
  );

  tool(
    "interchange_object",
    "One block as a pkm-interchange object: properties, tags, archived, created, updated. Paired with interchange_types, this is readable by anything that knows the format and nothing about Hermes.",
    { id: z.string().describe("block id") },
    run(async (a: { id: string }) => {
      const [b, types] = await Promise.all([
        api.get<Record<string, unknown>>(`/blocks/${a.id}`),
        api.get<{ id: string; name: string; isText: boolean; propertySchema: PropertySchema | null }[]>("/block-types"),
      ]);
      const { envelope } = toInterchange({
        types: types.map((t) => ({ ...t, propertySchema: t.propertySchema ?? null })),
        blocks: [
          {
            id: String(b.id),
            blockTypeId: (b.blockTypeId as string) ?? null,
            collectionKind: (b.collectionKind as string) ?? null,
            content: (b.content as string) ?? null,
            properties: (b.properties ?? {}) as Record<string, unknown>,
            archivedAt: (b.archivedAt as string) ?? null,
            createdAt: String(b.createdAt),
            updatedAt: String(b.updatedAt),
            seriesId: (b.seriesId as string) ?? null,
          },
        ],
        memberships: [],
      });
      const [only] = (envelope as { objects: unknown[] }).objects;
      return JSON.stringify(only ?? null, null, 2);
    }),
  );

  tool(
    "interchange_patch",
    "Write part of a block: set these properties, remove those, leave everything else exactly as it is — including properties you have never heard of. This is the safe way to change one field. The answer says whether anything was lost.",
    {
      id: z.string().describe("block id"),
      set: z.record(z.unknown()).optional().describe("properties to write"),
      unset: z.array(z.string()).optional().describe("properties to remove — the only way to remove one"),
    },
    run(async (a: { id: string; set?: Record<string, unknown>; unset?: string[] }) => {
      const b = await api.get<{ version: number }>(`/blocks/${a.id}`);
      await api.patch(`/blocks/${a.id}`, {
        version: b.version,
        patch: { set: a.set ?? {}, unset: a.unset ?? [] },
      });
      // Hermes stores properties as an open bag, so there is nothing it can be
      // handed that it cannot keep. Saying "full" is a promise, and it is worth
      // something only because it is not said defensively.
      return JSON.stringify({ ok: true, fidelity: "full", reports: [] });
    }),
  );

  tool(
    "list_types",
    "List the block types available (name, and whether it's a plain-text type). " +
      'Pass as:"interchange" for the pkm-interchange form — fields with value kinds, and the ' +
      "profiles each type declares — which is how to learn which field carries a due date or a " +
      "completion state without knowing what this account calls them.",
    { as: z.enum(["prose", "interchange"]).optional() },
    run(async (a: { as?: string }) => {
      const types = await getTypes();
      if (a.as === "interchange") {
        const full = await api.get<
          { id: string; name: string; isText: boolean; propertySchema: PropertySchema | null }[]
        >("/block-types");
        const { envelope } = toInterchange({
          types: full.map((t) => ({ ...t, propertySchema: t.propertySchema ?? null })),
          blocks: [],
          memberships: [],
        });
        return JSON.stringify((envelope as { types: unknown[] }).types, null, 2);
      }
      return types.length ? types.map((t) => `- ${t.name}${t.isText ? " (text)" : ""}`).join("\n") : "No types.";
    }),
  );

  tool(
    "block_create",
    "Create a block of ANY type. `type` is a block-type name (omit, or 'text', for a plain note). " +
      "For text notes pass `content`; for typed blocks pass `title` and any other fields via `fields` " +
      "(a JSON object of property-key → value, e.g. {\"description\":\"…\",\"location\":\"…\"}). Tags are created as needed.",
    {
      type: z.string().optional(),
      title: z.string().optional(),
      content: z.string().optional(),
      fields: z.record(z.unknown()).optional(),
      tags: z.array(z.string()).optional(),
    },
    run(async (a) => {
      const type = await resolveType(a.type);
      const body: Record<string, unknown> = { blockTypeId: type.id };
      if (type.isText) {
        body.content = a.content ?? a.title ?? "";
      } else {
        const props: Record<string, unknown> = { ...(a.fields ?? {}) };
        if (a.title !== undefined) props.title = a.title;
        body.properties = props;
      }
      const b = await api.post<{ id: string }>("/blocks", body);
      if (a.tags?.length)
        await api.put(`/blocks/${b.id}/tags`, { tags: a.tags.map((t) => t.trim().toLowerCase().replace(/^#+/, "")) });
      return `Created ${type.isText ? "note" : type.name} [${b.id}].`;
    }),
  );

  tool(
    "block_archive",
    "Archive a block (id or title): hide it from every normal view and query. Reversible via block_unarchive — memberships and positions are preserved, so it returns exactly where it was. This replaces deletion; there is no delete tool. Collections can't be archived.",
    { block: z.string().min(1) },
    run(async (a) => {
      const id = await resolveBlockId(a.block);
      await api.post(`/blocks/${id}/archive`, {});
      return `Archived [${id}].`;
    }),
  );

  tool(
    "block_unarchive",
    "Restore an archived block by id — it reappears everywhere it was. (Pass the id; archived blocks aren't found by title search.)",
    { id: z.string().uuid() },
    run(async (a) => {
      await api.post(`/blocks/${a.id}/unarchive`, {});
      return `Unarchived [${a.id}].`;
    }),
  );

  tool(
    "collection_create",
    "Create a collection. kind: list | document | matrix | table | canvas | kanban | masonry | calendar. " +
      "Optionally seed it with existing blocks by id or title. (For a laid-out canvas use canvas_create instead.)",
    {
      kind: z.enum(["list", "document", "matrix", "table", "canvas", "kanban", "masonry", "calendar"]),
      title: z.string(),
      description: z.string().optional(),
      members: z.array(z.string()).optional(),
    },
    run(async (a) => {
      const c = await api.post<{ id: string }>("/collections", { kind: a.kind, title: a.title, description: a.description });
      let added = 0;
      for (const m of a.members ?? []) {
        try {
          await api.post(`/collections/${c.id}/members`, { blockId: await resolveBlockId(m) });
          added++;
        } catch {
          /* skip unresolved/duplicate member */
        }
      }
      return `Created ${a.kind} collection "${a.title}" [${c.id}]${added ? ` with ${added} member${added === 1 ? "" : "s"}` : ""}.`;
    }),
  );

  tool(
    "collection_add",
    "Add an existing block (id or title) to a collection (id or title).",
    { collection: z.string(), block: z.string() },
    run(async (a) => {
      const colId = await resolveCollectionId(a.collection);
      const id = await resolveBlockId(a.block);
      await api.post(`/collections/${colId}/members`, { blockId: id });
      return `Added [${id}] to collection [${colId}].`;
    }),
  );

  tool(
    "canvas_create",
    "Create a canvas and arrange the given blocks (ids or titles) on it. " +
      "layout: grid | row | column. connect=true chains the items with arrows in the given order " +
      "(use this for an ordered flow, e.g. arranging tasks in sequence). Decide the order yourself, " +
      "then pass items in that order.",
    {
      title: z.string(),
      items: z.array(z.string()).min(1),
      layout: z.enum(["grid", "row", "column"]).default("grid"),
      connect: z.boolean().default(false),
    },
    run(async (a) => {
      const ids: string[] = [];
      for (const it of a.items) ids.push(await resolveBlockId(it));
      const c = await api.post<{ id: string }>("/collections", { kind: "canvas", title: a.title });
      const W = 280;
      const H = 190;
      const GAP = 60;
      const n = ids.length;
      const cols = a.layout === "row" ? n : a.layout === "column" ? 1 : Math.max(1, Math.ceil(Math.sqrt(n)));
      const pos = (i: number) => ({ x: (i % cols) * (W + GAP), y: Math.floor(i / cols) * (H + GAP) });
      for (let i = 0; i < n; i++) {
        const p = pos(i);
        await api.post(`/collections/${c.id}/members`, { blockId: ids[i], context: { x: p.x, y: p.y, w: W, h: H } });
      }
      if (a.connect && n > 1) {
        // Emit fully-formed edges (id + facing sides + arrow/live) so the canvas
        // renderer can draw them; a bare {from,to} would crash the view.
        const edges = ids.slice(0, -1).map((from, i) => {
          const to = ids[i + 1];
          const pf = pos(i);
          const pt = pos(i + 1);
          const horizontal = Math.abs(pt.x - pf.x) >= Math.abs(pt.y - pf.y);
          const [fromSide, toSide] = horizontal
            ? pt.x >= pf.x
              ? ["e", "w"]
              : ["w", "e"]
            : pt.y >= pf.y
              ? ["s", "n"]
              : ["n", "s"];
          return { id: randomUUID(), from, to, fromSide, toSide, arrow: "forward", live: true };
        });
        await api.patch(`/collections/${c.id}`, { canvas_edges: edges });
      }
      return `Created canvas "${a.title}" [${c.id}] with ${n} block${n === 1 ? "" : "s"}${a.connect ? ", connected in order" : ""}.`;
    }),
  );

  interface CanvasNote {
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
    text: string;
    color?: string | null;
  }
  interface CanvasEdge {
    id: string;
    from: string;
    to: string;
    fromSide?: string;
    toSide?: string;
    arrow?: string;
    live?: boolean;
    dash?: string;
    label?: string;
  }
  interface CanvasData {
    id: string;
    notes: CanvasNote[];
    edges: CanvasEdge[];
    members: {
      id: string;
      label: string;
      rect: { x: number; y: number; w: number; h: number } | null;
    }[];
  }

  /**
   * Everything on a canvas, in one shape: its blocks, its ephemeral notes, and
   * the connections between them. A canvas keeps notes and connections in the
   * collection's own properties rather than as rows of their own, so this is
   * also the only way to see them.
   */
  const canvasData = async (nameOrId: string): Promise<CanvasData> => {
    const id = await resolveCollectionId(nameOrId);
    const d = await api.get<{
      collection: { collectionKind: string | null; properties: Record<string, unknown> };
      members: {
        id: string;
        properties: Record<string, unknown>;
        content?: string | null;
        context?: Record<string, unknown>;
      }[];
    }>(`/collections/${id}`);
    if (d.collection.collectionKind !== "canvas") throw new Error(`"${nameOrId}" is not a canvas.`);
    const props = d.collection.properties;
    const rectOf = (ctx: Record<string, unknown> | undefined) => {
      const n = (k: string) => (typeof ctx?.[k] === "number" ? (ctx[k] as number) : null);
      const x = n("x");
      const y = n("y");
      return x != null && y != null ? { x, y, w: n("w") ?? 200, h: n("h") ?? 120 } : null;
    };
    return {
      id,
      notes: Array.isArray(props.canvas_notes) ? (props.canvas_notes as CanvasNote[]) : [],
      edges: Array.isArray(props.canvas_edges) ? (props.canvas_edges as CanvasEdge[]) : [],
      members: d.members.map((m) => ({
        id: m.id,
        label: String(m.properties.title ?? "") || (m.content ?? "").split("\n")[0] || "Untitled",
        rect: rectOf(m.context),
      })),
    };
  };

  /**
   * A thing on a canvas, by id or by what it says. Notes have no titles, so a
   * fragment of their text is the only handle anyone has on them — and a caller
   * that just read the canvas will use the ids it was given.
   */
  const canvasNodeId = (c: CanvasData, ref: string): string => {
    const r = ref.trim();
    const lower = r.toLowerCase();
    const note =
      c.notes.find((n) => n.id === r) ??
      c.notes.find((n) => n.text.trim().toLowerCase() === lower) ??
      c.notes.find((n) => n.text.toLowerCase().includes(lower));
    if (note) return note.id;
    const member =
      c.members.find((m) => m.id === r) ??
      c.members.find((m) => m.label.toLowerCase() === lower) ??
      c.members.find((m) => m.label.toLowerCase().includes(lower));
    if (member) return member.id;
    throw new Error(
      `Nothing on this canvas matches "${ref}". Read it with collection_members first — notes are matched by their text, blocks by their title or id.`,
    );
  };

  /** The sides two nodes should meet on, given where they sit. */
  const facingSides = (c: CanvasData, from: string, to: string): { fromSide: string; toSide: string } => {
    const rect = (id: string) =>
      c.notes.find((n) => n.id === id) ?? c.members.find((m) => m.id === id)?.rect ?? null;
    const a = rect(from);
    const b = rect(to);
    if (!a || !b) return { fromSide: "e", toSide: "w" };
    const dx = b.x + b.w / 2 - (a.x + a.w / 2);
    const dy = b.y + b.h / 2 - (a.y + a.h / 2);
    return Math.abs(dx) >= Math.abs(dy)
      ? { fromSide: dx > 0 ? "e" : "w", toSide: dx > 0 ? "w" : "e" }
      : { fromSide: dy > 0 ? "s" : "n", toSide: dy > 0 ? "n" : "s" };
  };

  tool(
    "canvas_note",
    "Sticky notes on a canvas — the free-floating text that lives ONLY there. These are NOT Hermes blocks: they have no block id, don't appear in search or listings, and can't be linked from anywhere else. Use this (not block_create) whenever asked to jot a note, label, caption or comment ON a canvas. `action` is add (default), edit, or remove; for edit/remove, `note` identifies it by its id or by a fragment of its text (read the canvas with collection_members first). x/y are canvas coordinates, `color` a hex background. `text` is markdown — headings, lists, checkboxes, links — rendered the same way as any long-text field.",
    {
      canvas: z.string(),
      action: z.enum(["add", "edit", "remove"]).default("add"),
      text: z.string().min(1).max(10_000).optional(),
      note: z.string().optional(),
      x: z.number().finite().optional(),
      y: z.number().finite().optional(),
      // Hex only: this lands in a CSS `background`, where a value like
      // `url(https://evil/x.png)` would fire an outbound request (a read
      // receipt) the moment the canvas renders.
      color: HEX_COLOR.optional(),
    },
    run(async (a) => {
      const c = await canvasData(a.canvas);
      if (a.action === "add") {
        if (!a.text) throw new Error("A note needs text to add.");
        // Cascade unspecified notes diagonally so they don't stack exactly.
        const step = (c.notes.length % 6) * 36;
        const note = {
          id: `n:${randomUUID()}`,
          x: a.x ?? 40 + step,
          y: a.y ?? 40 + step,
          w: 200,
          h: 120,
          text: a.text,
          color: a.color ?? "#fdf3d8",
        };
        await api.patch(`/collections/${c.id}`, { canvas_notes: [...c.notes, note] });
        return `Added a sticky note to canvas "${a.canvas}" [${note.id}].`;
      }
      if (!a.note) throw new Error(`Which note? Give its id or a fragment of its text.`);
      const nodeId = canvasNodeId(c, a.note);
      const target = c.notes.find((n) => n.id === nodeId);
      if (!target) throw new Error(`"${a.note}" is a block on this canvas, not a sticky note.`);
      if (a.action === "remove") {
        await api.patch(`/collections/${c.id}`, {
          canvas_notes: c.notes.filter((n) => n.id !== nodeId),
          // A note that's gone can't stay connected to anything.
          canvas_edges: c.edges.filter((e) => e.from !== nodeId && e.to !== nodeId),
        });
        return `Removed the sticky note and any connections to it.`;
      }
      const next = c.notes.map((n) =>
        n.id === nodeId
          ? {
              ...n,
              ...(a.text !== undefined ? { text: a.text } : {}),
              ...(a.x !== undefined ? { x: a.x } : {}),
              ...(a.y !== undefined ? { y: a.y } : {}),
              ...(a.color !== undefined ? { color: a.color } : {}),
            }
          : n,
      );
      await api.patch(`/collections/${c.id}`, { canvas_notes: next });
      return `Updated the sticky note [${nodeId}].`;
    }),
  );

  tool(
    "canvas_connect",
    "Draw or erase a connection between two things on a canvas — blocks, sticky notes, or one of each. Each side is named by id, by a block's title, or by a fragment of a note's text. `action` is connect (default) or disconnect. Optional `label` writes on the line, `arrow` is forward (default), back, both or none, and `dash` is solid, dashed or dotted. Two things can only be connected once; connecting them again restyles the line that's there.",
    {
      canvas: z.string(),
      from: z.string().min(1),
      to: z.string().min(1),
      action: z.enum(["connect", "disconnect"]).default("connect"),
      label: z.string().max(200).optional(),
      arrow: z.enum(["forward", "back", "both", "none"]).optional(),
      dash: z.enum(["solid", "dashed", "dotted"]).optional(),
    },
    run(async (a) => {
      const c = await canvasData(a.canvas);
      const from = canvasNodeId(c, a.from);
      const to = canvasNodeId(c, a.to);
      if (from === to) throw new Error("Those are the same thing.");
      const existing = c.edges.find(
        (e) => (e.from === from && e.to === to) || (e.from === to && e.to === from),
      );
      if (a.action === "disconnect") {
        if (!existing) return "They weren't connected.";
        await api.patch(`/collections/${c.id}`, {
          canvas_edges: c.edges.filter((e) => e.id !== existing.id),
        });
        return `Disconnected "${a.from}" from "${a.to}".`;
      }
      const style = {
        ...(a.label !== undefined ? { label: a.label } : {}),
        ...(a.arrow ? { arrow: a.arrow } : {}),
        ...(a.dash && a.dash !== "solid" ? { dash: a.dash } : {}),
      };
      if (existing) {
        // One line per pair, as on the canvas itself — a second would sit
        // exactly on top of the first.
        await api.patch(`/collections/${c.id}`, {
          canvas_edges: c.edges.map((e) => (e.id === existing.id ? { ...e, ...style } : e)),
        });
        return `Those were already connected — restyled that line instead.`;
      }
      // A line between two real blocks is "live"; anything touching a sticky
      // note is ephemeral, and shows dotted, because a note isn't a block.
      const eph = from.startsWith("n:") || to.startsWith("n:");
      const edge = {
        id: randomUUID(),
        from,
        to,
        ...facingSides(c, from, to),
        arrow: a.arrow ?? "forward",
        live: !eph,
        ...(eph && !a.dash ? { dash: "dotted" } : {}),
        ...style,
      };
      await api.patch(`/collections/${c.id}`, { canvas_edges: [...c.edges, edge] });
      return `Connected "${a.from}" → "${a.to}" on "${a.canvas}".`;
    }),
  );

  tool(
    "collection_members",
    "What's in a collection (id or title): members with their labels and ids, plus the matrix region where placed. For a CANVAS this also lists its sticky notes and every connection drawn between things on it — that's the only way to see either, since neither is a block.",
    { collection: z.string() },
    run(async (a) => {
      const id = await resolveCollectionId(a.collection);
      const d = await api.get<{
        collection: { collectionKind: string | null; properties: Record<string, unknown> };
        members: { id: string; properties: Record<string, unknown>; content?: string | null; context?: Record<string, unknown> }[];
      }>(`/collections/${id}`);
      let members = d.members;
      // A matrix stores explicit placements but only shows the ones its query
      // still matches (the board hides the rest). Mirror that here so members
      // reflect the collection's own criteria — not a hardcoded status.
      const filter = d.collection.properties.filter_query;
      if (d.collection.collectionKind === "matrix" && filter != null) {
        const live = await api.post<{ id: string }[]>("/blocks/query", { filterQuery: filter });
        const liveIds = new Set(live.map((b) => b.id));
        members = members.filter((m) => liveIds.has(m.id));
      }
      const regions = Array.isArray(d.collection.properties.matrix_regions)
        ? (d.collection.properties.matrix_regions as { title?: string }[])
        : null;
      const labelOfMember = (m: (typeof members)[number]) =>
        String(m.properties.title ?? "") || (m.content ?? "").split("\n")[0] || "Untitled";
      const out: string[] = [];
      if (members.length) {
        out.push(
          ...members.map((m) => {
            const r = m.context?.region;
            const region = regions && r != null ? ` — region "${regions[Number(r)]?.title || r}"` : "";
            return `- ${labelOfMember(m)}${region} [${m.id}]`;
          }),
        );
      }
      // A canvas keeps its sticky notes and its connections in the collection's
      // own properties rather than as rows, so nothing else surfaces them.
      if (d.collection.collectionKind === "canvas") {
        const c = await canvasData(id);
        if (c.notes.length) {
          out.push("", "Sticky notes (canvas-only, not blocks):");
          out.push(
            ...c.notes.map((n) => `- "${n.text.replace(/\s+/g, " ").trim().slice(0, 120)}" [${n.id}]`),
          );
        }
        if (c.edges.length) {
          const name = (nodeId: string) =>
            c.notes.find((n) => n.id === nodeId)
              ? `note "${c.notes.find((n) => n.id === nodeId)!.text.replace(/\s+/g, " ").trim().slice(0, 40)}"`
              : c.members.find((m) => m.id === nodeId)?.label ?? nodeId;
          out.push("", "Connections:");
          out.push(
            ...c.edges.map((e) => {
              const arrow = e.arrow === "back" ? "←" : e.arrow === "both" ? "↔" : e.arrow === "none" ? "—" : "→";
              return `- ${name(e.from)} ${arrow} ${name(e.to)}${e.label ? ` ("${e.label}")` : ""}`;
            }),
          );
        }
      }
      return out.length ? out.join("\n") : "No members.";
    }),
  );

  tool(
    "collection_remove",
    "Remove a block (id or title) from a collection (id or title). The block itself is NOT deleted.",
    { collection: z.string(), block: z.string() },
    run(async (a) => {
      const colId = await resolveCollectionId(a.collection);
      const id = await resolveBlockId(a.block);
      await api.del(`/collections/${colId}/members/${id}`);
      return `Removed [${id}] from collection [${colId}].`;
    }),
  );

  tool(
    "matrix_place",
    "Place a block (id or title) into a named region of a matrix collection — e.g. the \"Do\" quadrant of an " +
      "Eisenhower matrix. `region` matches the region/quadrant title.",
    { matrix: z.string(), block: z.string(), region: z.string() },
    run(async (a) => {
      const colId = await resolveCollectionId(a.matrix);
      const d = await api.get<{ collection: { collectionKind: string | null; properties: Record<string, unknown> } }>(
        `/collections/${colId}`,
      );
      if (d.collection.collectionKind !== "matrix") throw new Error(`"${a.matrix}" is not a matrix.`);
      const regions = (d.collection.properties.matrix_regions as { title?: string }[] | undefined) ?? [];
      const needle = a.region.trim().toLowerCase();
      let region = regions.findIndex((r) => String(r.title ?? "").toLowerCase() === needle);
      if (region < 0) region = regions.findIndex((r) => String(r.title ?? "").toLowerCase().includes(needle));
      if (region < 0)
        throw new Error(`No region "${a.region}". Regions: ${regions.map((r) => r.title || "(untitled)").join(", ")}.`);
      const blockId = await resolveBlockId(a.block);
      try {
        await api.post(`/collections/${colId}/members`, { blockId, context: { region } });
      } catch {
        await api.patch(`/collections/${colId}/members/${blockId}`, { context: { region } });
      }
      return `Placed [${blockId}] in region "${regions[region]?.title || region}" of matrix [${colId}].`;
    }),
  );

  tool(
    "collection_create_smart",
    "Create a query-fed (smart) collection that auto-includes matching blocks. Filter by `type` (block-type name), " +
      "`tags`, and/or a text `term`. match: all (default) requires every condition, any requires one.",
    {
      kind: z.enum(["list", "document", "matrix", "table", "kanban", "masonry", "calendar"]),
      title: z.string(),
      type: z.string().optional(),
      tags: z.array(z.string()).optional(),
      term: z.string().optional(),
      match: z.enum(["all", "any"]).default("all"),
    },
    run(async (a) => {
      const items: (Condition | FilterGroup)[] = [];
      if (a.type) items.push({ kind: "blockType", typeId: (await resolveType(a.type)).id } as Condition);
      for (const tg of a.tags ?? [])
        items.push({ kind: "tag", tag: tg.trim().toLowerCase().replace(/^#+/, ""), op: "include" } as Condition);
      if (a.term) items.push({ kind: "text", value: a.term } as Condition);
      if (!items.length) throw new Error("Give at least one of type, tags, or term.");
      const c = await api.post<{ id: string }>("/collections", {
        kind: a.kind,
        title: a.title,
        membershipMode: "smart",
        filterQuery: group(items, a.match),
      });
      return `Created smart ${a.kind} "${a.title}" [${c.id}] (${items.length} condition${items.length === 1 ? "" : "s"}).`;
    }),
  );

  // ---------- today sheet layout ----------

  const todayISO = async () => {
    const s = await api.get<{ timezone: string | null }>("/settings").catch(() => ({ timezone: null }));
    // en-CA formats as YYYY-MM-DD. The reader's zone, else the instance's; only
    // with neither does this fall back to the box's own clock, which is where
    // "add this to today's note" used to land on tomorrow's after about 8pm.
    const tz = effectiveTimeZone(s.timezone);
    return new Intl.DateTimeFormat("en-CA", tz ? { timeZone: tz } : {}).format(new Date());
  };
  // A canvas/table/etc. is a collection; anything else resolves as a note block.
  const resolveSection = async (
    item: string,
    as?: "collection" | "note",
  ): Promise<{ t: "collection" | "block"; id: string }> => {
    const s = item.trim();
    if (as === "collection") return { t: "collection", id: await resolveCollectionId(s) };
    if (as === "note") return { t: "block", id: await resolveBlockId(s) };
    const cols = await api.get<{ id: string; properties: Record<string, unknown> }[]>("/collections");
    const n = s.toLowerCase();
    const col = UUID.test(s)
      ? cols.find((c) => c.id === s)
      : cols.find((c) => String(c.properties.title ?? "").toLowerCase() === n) ??
        cols.find((c) => String(c.properties.title ?? "").toLowerCase().includes(n));
    return col ? { t: "collection", id: col.id } : { t: "block", id: await resolveBlockId(s) };
  };
  const scopePhrase = (scope: string, date: string) =>
    scope === "all"
      ? "on all Dailies (past, present, and future)"
      : scope === "today_forward"
        ? `on ${date} and all future Dailies`
        : `on ${date}`;

  interface LayoutSection {
    t: string;
    id?: string;
    label: string;
    source: "standard" | "day" | "default";
    scope?: "all" | "today_forward" | "range" | null;
    range?: { from: string | null; until: string | null };
  }

  /**
   * The day's scratchpad, brought into being if nobody has opened that day yet.
   * A daily note isn't something you create — it exists because someone went to
   * the day, and asking for it over MCP is that same act. Without this an agent
   * asked to "put this in today's note" would search, find nothing, and either
   * give up or invent an ordinary note that the Today page never shows.
   */
  interface DailyNote {
    id: string;
    content: string | null;
    version: number;
    properties: Record<string, unknown>;
  }
  const dailyNote = (date: string) => api.get<DailyNote>(`/today/${date}/note`);

  tool(
    "daily_note_get",
    "Read the daily note (the Today page's scratchpad) for a date — creating it if that day has never been opened, so this never comes back empty-handed. date defaults to today (YYYY-MM-DD). Use this rather than searching for a note by its date: daily notes are kept out of ordinary block listings.",
    { date: ISO_DATE.optional() },
    run(async (a) => {
      const date = a.date?.trim() || (await todayISO());
      const note = await dailyNote(date);
      const body = (note.content ?? "").trim();
      return `Daily note ${date} [${note.id}]\n\n${body || "(empty)"}`;
    }),
  );

  tool(
    "daily_note_append",
    "Add text to the end of a day's daily note (the Today page's scratchpad), creating the note if that day has never been opened. Markdown — use \"- \" for a bullet, \"- [ ] \" for a checklist item. date defaults to today. To replace the whole note instead, read it with daily_note_get and write it with block_update.",
    { text: z.string().min(1), date: ISO_DATE.optional() },
    run(async (a) => {
      const date = a.date?.trim() || (await todayISO());
      const note = await dailyNote(date);
      const before = (note.content ?? "").replace(/\s+$/, "");
      const addition = a.text.trim();
      // A blank line between what was there and what's arriving: two paragraphs
      // run together otherwise, and a bullet list appended to a paragraph would
      // swallow the first item.
      const content = before ? `${before}\n\n${addition}\n` : `${addition}\n`;
      await api.patch(`/blocks/${note.id}`, { content, version: note.version });
      return `Added to the daily note for ${date}.`;
    }),
  );

  tool(
    "today_layout_get",
    "Show the section layout of a Today sheet (which collections/notes are pinned, and whether each is just this day or on all Dailies). date defaults to today (YYYY-MM-DD).",
    { date: ISO_DATE.optional() },
    run(async (a) => {
      const date = a.date?.trim() || (await todayISO());
      const { sections } = await api.get<{ sections: LayoutSection[] }>(`/today/${date}/layout`);
      const lines = sections.map((s) => {
        if (s.source === "standard") return `- ${s.label} (standard)`;
        const kind = s.t === "collection" ? "collection" : "note";
        const scope =
          s.scope === "all"
            ? " — on all Dailies"
            : s.scope === "today_forward"
              ? ` — from ${s.range?.from} onward`
              : s.scope === "range"
                ? ` — ${s.range?.from ?? "…"} to ${s.range?.until}`
                : " — this day only";
        return `- ${s.label} (${kind})${scope} [${s.id}]`;
      });
      return `Today sheet ${date}:\n${lines.join("\n")}`;
    }),
  );

  tool(
    "today_layout_add",
    "Pin a collection (canvas/table/…) or note as a section on a Today sheet. `after` anchors it just below a standard section (scratchpad | relevant | activity; default scratchpad). `scope`: today (this day only, default), today_forward (this day and all future Dailies), or all (every Daily past/present/future). date defaults to today.",
    {
      item: z.string().min(1),
      as: z.enum(["collection", "note"]).optional(),
      after: z.enum(["scratchpad", "relevant", "activity"]).default("scratchpad"),
      scope: z.enum(["today", "today_forward", "all"]).default("today"),
      date: ISO_DATE.optional(),
    },
    run(async (a) => {
      const date = a.date?.trim() || (await todayISO());
      const section = await resolveSection(a.item, a.as);
      await api.post(`/today/${date}/layout/add`, { section, after: a.after, scope: a.scope });
      return `Added "${a.item}" below ${a.after} ${scopePhrase(a.scope, date)}.`;
    }),
  );

  tool(
    "today_layout_remove",
    "Remove a pinned collection/note section from a Today sheet. `scope`: today (just this day — hides an all-Dailies section only here, default), today_forward (this day and all future Dailies), or all (remove from every Daily). date defaults to today.",
    {
      item: z.string().min(1),
      as: z.enum(["collection", "note"]).optional(),
      scope: z.enum(["today", "today_forward", "all"]).default("today"),
      date: ISO_DATE.optional(),
    },
    run(async (a) => {
      const date = a.date?.trim() || (await todayISO());
      const section = await resolveSection(a.item, a.as);
      await api.post(`/today/${date}/layout/remove`, { section, scope: a.scope });
      return `Removed "${a.item}" ${scopePhrase(a.scope, date)}.`;
    }),
  );

  tool(
    "today_layout_move",
    "Reorder this day's own sections (standard sections and day-only pins). Place `item` right after `after` (a section title/id, or a standard section name); omit `after` to move it to the top. Sections that come from all-Dailies defaults are anchored under a standard section and can't be moved here. date defaults to today.",
    { item: z.string().min(1), after: z.string().optional(), date: ISO_DATE.optional() },
    run(async (a) => {
      const date = a.date?.trim() || (await todayISO());
      const { sections } = await api.get<{ sections: LayoutSection[] }>(`/today/${date}/layout`);
      const keyOf = (s: LayoutSection) => (s.t === "collection" || s.t === "block" ? `${s.t}:${s.id}` : s.t);
      // Day-owned sections only (defaults are anchored, not reorderable here).
      const owned = sections.filter((s) => s.source !== "default");
      const target = await resolveSection(a.item).catch(() => null);
      const itemKey = target ? `${target.t}:${target.id}` : a.item.trim().toLowerCase();
      const idx = owned.findIndex((s) => keyOf(s) === itemKey || s.label.toLowerCase() === a.item.trim().toLowerCase());
      if (idx < 0) throw new Error(`"${a.item}" isn't a movable section on ${date}.`);
      const [moved] = owned.splice(idx, 1);
      let at = 0;
      if (a.after) {
        const aft = a.after.trim().toLowerCase();
        const afterTarget = await resolveSection(a.after).catch(() => null);
        const afterKey = afterTarget ? `${afterTarget.t}:${afterTarget.id}` : aft;
        const ai = owned.findIndex((s) => keyOf(s) === afterKey || s.t === aft || s.label.toLowerCase() === aft);
        if (ai < 0) throw new Error(`Can't find section "${a.after}" to place after.`);
        at = ai + 1;
      }
      owned.splice(at, 0, moved!);
      const layout = owned.map((s) => (s.t === "collection" || s.t === "block" ? { t: s.t, id: s.id } : { t: s.t }));
      await api.put(`/today/${date}/layout`, { layout });
      return `Moved "${moved!.label}"${a.after ? ` after ${a.after}` : " to the top"} on ${date}.`;
    }),
  );

  /**
   * The day's actual schedule: subscribed feed events merged with Hermes 'event'
   * blocks. Shared by calendar_events and daily_review — a feed read that fails
   * is reported, never quietly dropped, because "no events" and "we couldn't
   * look" are the same sentence to a reader and opposite facts.
   */
  const gatherCalendar = async (start: string, end: string): Promise<{ events: CalItem[]; failed: string | null }> => {
    let failed: string | null = null;
    const feed = await api
      .get<{ events: CalFeedEvent[] }>(
        `/calendar/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
      )
      .catch((e: unknown) => {
        failed = e instanceof Error ? e.message : String(e);
        return { events: [] as CalFeedEvent[] };
      });
    const events: CalItem[] = feed.events.map((e) => ({
      start: e.start,
      allDay: e.allDay,
      title: e.summary || "Untitled",
      location: e.location || "",
      source: e.feedName || "feed",
    }));

    const types = await api
      .get<{ id: string; name: string; propertySchema?: { fields: { key: string; type: string }[] } | null }[]>(
        "/block-types",
      )
      .catch(() => []);
    const eventType = types.find((t) => t.name.trim().toLowerCase() === "event");
    if (eventType) {
      const dateFields = (eventType.propertySchema?.fields ?? []).filter(
        (f) => f.type === "date" || f.type === "datetime" || f.type === "datespan",
      );
      const rows = await api.get<HermesBlock[]>(`/blocks/of-type/${eventType.id}`).catch(() => []);
      for (const b of rows) {
        const props = b.properties as Record<string, unknown>;
        const r = eventDates(props, dateFields);
        if (r && r.startDay <= end && r.endDay >= start) {
          events.push({
            start: r.startRaw,
            allDay: !/T\d/.test(r.startRaw),
            title: String(props.title ?? "Untitled"),
            location: typeof props.location === "string" ? props.location : "",
            source: "event",
            id: b.id,
          });
        }
      }
    }
    events.sort((x, y) => x.start.localeCompare(y.start));
    return { events, failed };
  };

  tool(
    "daily_review",
    "Everything bearing on one day, in one call: the calendar (subscribed feeds + Hermes event blocks), tasks overdue as of that day, tasks due that day, tasks available to work on, anything else whose dates land on it, and the day's note. date defaults to today (YYYY-MM-DD). Use this for \"how does my day look\", a morning or evening review, or planning a specific date — it answers in one call what calendar_events + several task_find calls would.",
    { date: ISO_DATE.optional() },
    run(async (a) => {
      const date = a.date?.trim() || (await todayISO());
      const ctx = await loadContext(api);
      const out: string[] = [];
      const label = new Date(`${date}T00:00`).toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      });
      out.push(`Daily review — ${label} (${date})`);

      // ── Calendar ────────────────────────────────────────────────────
      const cal = await gatherCalendar(date, date);
      out.push("", "Calendar:");
      if (cal.failed) {
        // Loud, and never as an empty calendar: the assistant saying "your day
        // is clear" when the feeds simply couldn't be read is the worst
        // possible failure of a tool like this.
        out.push(
          `- COULD NOT READ THE CALENDAR FEEDS (${cal.failed}). Feed events are MISSING below — do not tell the user their calendar is clear.`,
        );
      }
      if (!cal.events.length && !cal.failed) out.push("- nothing scheduled");
      for (const e of cal.events) {
        const time = e.allDay ? "all day" : fmtEventTime(e.start);
        const loc = e.location ? ` @ ${e.location}` : "";
        out.push(`- ${time} — ${e.title}${loc} [${e.source}]${e.id ? ` (${e.id})` : ""}`);
      }

      // ── Tasks, all judged as of the day under review ────────────────
      // asOf makes "today" inside these filters mean the reviewed date, so a
      // review of last Tuesday reports what was overdue THEN, not now.
      const openTask = (extra: (Condition | FilterGroup)[]) =>
        api.post<HermesBlock[]>("/blocks/query", {
          filterQuery: group([
            { kind: "blockType", typeId: ctx.taskTypeId } as Condition,
            ...openConds(ctx),
            ...extra,
          ]),
          asOf: date,
        });
      const endKey = `${ctx.spanKey}.end`;
      const startKey = `${ctx.spanKey}.start`;
      // Everything due by end of that day — overdue and due-that-day together,
      // which is how the dates compare; split below by their own end date.
      const dueBy = await openTask([prop(endKey, "lt", "today+1")]);
      const endDay = (b: HermesBlock) => {
        const span = ((b.properties as Record<string, unknown>)[ctx.spanKey] ?? {}) as { end?: string };
        return typeof span.end === "string" ? span.end.slice(0, 10) : "";
      };
      const overdue = dueBy.filter((b) => endDay(b) && endDay(b) < date);
      const dueToday = dueBy.filter((b) => endDay(b) === date);
      // Started (or starting that day) and not already listed above.
      const listed = new Set(dueBy.map((b) => b.id));
      const started = await openTask([prop(startKey, "lt", "today+1")]);
      const available = started.filter((b) => !listed.has(b.id));

      const names = await projectNamesFor(api, ctx, [...overdue, ...dueToday, ...available]);
      const section = (title: string, rows: HermesBlock[]) => {
        out.push("", `${title}:`);
        if (!rows.length) out.push("- none");
        for (const b of rows) out.push(`- ${fmtTaskLine(ctx, b, names, date)}`);
      };
      section(`Overdue as of ${date}`, overdue);
      section("Due that day", dueToday);
      section("Available (started, not yet due)", available);

      // ── Anything else the day touches ───────────────────────────────
      // The Today sheet's own notion of relevance: any date or datespan field
      // landing on the day, whatever the type. Tasks and events are already
      // above, so only the rest is new information here.
      const sheet = await api
        .get<{ note: { content: string | null }; relevant: HermesBlock[] }>(`/today/${date}`)
        .catch(() => null);
      if (sheet) {
        const seen = new Set([...dueBy, ...available].map((b) => b.id));
        for (const e of cal.events) if (e.id) seen.add(e.id);
        const others = sheet.relevant.filter((b) => !seen.has(b.id) && b.blockTypeId !== ctx.taskTypeId);
        if (others.length) {
          out.push("", "Also dated to that day:");
          for (const b of others) {
            const p = b.properties as Record<string, unknown>;
            out.push(`- ${String(p.title ?? "Untitled")} (${b.id})`);
          }
        }
        const note = (sheet.note?.content ?? "").trim();
        out.push("", `Daily note: ${note ? `\n${note}` : "(empty)"}`);
      }

      return out.join("\n");
    }),
  );

  tool(
    "calendar_events",
    "The user's actual schedule for a day or range: their subscribed calendar FEED events (Google/Outlook/iCloud/school ICS) merged with their Hermes 'event' blocks, in time order. Use this for ANY question about the calendar, schedule, meetings, availability, or 'what's on today' — task_find and today_layout_get do NOT include calendar events, so never assume the calendar is clear without calling this. Dates are YYYY-MM-DD: pass `date` for one day, `start`+`end` for a range, or omit for today.",
    { date: ISO_DATE.optional(), start: ISO_DATE.optional(), end: ISO_DATE.optional() },
    run(async (a) => {
      let start = a.date ?? a.start ?? "";
      let end = a.date ?? a.end ?? "";
      if (!start || !end) {
        const today = await todayISO();
        if (!start) start = today;
        if (!end) end = start;
      }
      if (end < start) [start, end] = [end, start];

      const { events, failed: feedFailed } = await gatherCalendar(start, end);

      const range = start === end ? `on ${start}` : `from ${start} to ${end}`;
      if (feedFailed)
        throw new Error(
          `Could not read the calendar feeds (${feedFailed}). Their events are MISSING from this result, so do ` +
            `not tell the user their calendar is clear — say the feeds couldn't be read and retry.`,
        );
      if (!events.length) return `No calendar events ${range}.`;
      const multiDay = start !== end;
      const line = (e: CalItem) => {
        const date = multiDay ? `${e.start.slice(0, 10)} ` : "";
        const time = e.allDay ? "all day" : fmtEventTime(e.start);
        const loc = e.location ? ` @ ${e.location}` : "";
        const id = e.id ? ` (${e.id})` : "";
        return `- ${date}${time} — ${e.title}${loc} [${e.source}]${id}`;
      };
      return `Calendar ${start === end ? start : `${start} → ${end}`}:\n${events.map(line).join("\n")}`;
    }),
  );

  for (const t of tools) {
    t.destructive = DESTRUCTIVE_TOOLS.has(t.name);
    t.readOnly = READONLY_TOOLS.has(t.name);
  }
  return tools;
}

interface CalFeedEvent {
  summary: string;
  location: string;
  start: string;
  end: string | null;
  allDay: boolean;
  feedName: string;
}
interface CalItem {
  start: string;
  allDay: boolean;
  title: string;
  location: string;
  source: string;
  id?: string;
}

/** YYYY-MM-DD portion of a date/datetime string, or null. */
function calDay(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  const d = v.split("T")[0] ?? "";
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

/** The date range an event block covers, from its first populated date field. */
function eventDates(
  props: Record<string, unknown>,
  dateFields: { key: string; type: string }[],
): { startDay: string; endDay: string; startRaw: string } | null {
  for (const f of dateFields) {
    const v = props[f.key];
    if (f.type === "datespan" && v && typeof v === "object") {
      const span = v as { start?: unknown; end?: unknown };
      const s = calDay(span.start);
      if (s) return { startDay: s, endDay: calDay(span.end) ?? s, startRaw: String(span.start) };
    } else if (typeof v === "string") {
      const s = calDay(v);
      if (s) return { startDay: s, endDay: s, startRaw: v };
    }
  }
  return null;
}

/** "9:00 AM" from a wall-clock/ISO string; empty if it has no time. */
function fmtEventTime(s: string): string {
  const m = s.match(/T(\d{2}):(\d{2})/);
  if (!m) return "all day";
  let h = Number(m[1]);
  const ap = h < 12 ? "AM" : "PM";
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ap}`;
}

/** MCP adapter: expose the shared tool registry to external agents, tagging
 *  destructive/read-only tools so MCP clients gate them natively. */
export async function buildTools(server: McpServer, api: Api): Promise<void> {
  for (const t of await defineTools(api)) {
    const annotations = {
      title: t.name,
      ...(t.destructive ? { destructiveHint: true } : {}),
      ...(t.readOnly ? { readOnlyHint: true } : {}),
    };
    // Our ToolResult is structurally a subset of the SDK's CallToolResult (which
    // permits extra keys); cast the callback to satisfy the overload.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    server.tool(t.name, t.description, t.schema, annotations, t.handler as any);
  }
}

interface HermesBlock {
  id: string;
  blockTypeId: string | null;
  properties: unknown;
  version: number;
}

function isArchivedProject(ctx: Ctx, proj: HermesBlock): boolean {
  if (ctx.projectStatusKey && ctx.projectArchivedValue) {
    return String((proj.properties as Record<string, unknown>)[ctx.projectStatusKey] ?? "") === ctx.projectArchivedValue;
  }
  return false; // tag-based archive state is looked up separately (taggedArchivedIds)
}
