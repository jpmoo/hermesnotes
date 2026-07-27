import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Condition, FilterGroup } from "@hermes/shared";
import { z } from "zod";
import { Api, ApiError } from "./api.js";
import {
  ensurePersons,
  fmtTaskLine,
  fmtDate,
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
    case "today":
    case "due_today":
      // `contains` matches both date-only and datetime values for the day.
      return [prop(end, "contains", "today"), ...openConds(ctx)];
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
        `Unknown when="${when}". Use overdue, today, week, available, or unscheduled.`,
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

const DESTRUCTIVE_TOOLS = new Set(["delete_task", "delete_project", "block_delete", "tag_delete"]);
const READONLY_TOOLS = new Set([
  "search", "block_get", "list_types", "list_lists", "tag_list", "collection_members",
  "task_find", "task_info", "project_list", "project_archived", "project_info",
]);

/**
 * The full Hermes tool surface, bound to one caller's API client. This registry
 * is transport-agnostic: the MCP adapter (`buildTools`) exposes it to external
 * agents, and the in-app assistant invokes the same handlers in-process. Define
 * every capability here exactly once.
 */
export function defineTools(api: Api): ToolDef[] {
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
    "Create a task. Dates are YYYY-MM-DD (optionally with THH:mm). project/projects accept a project title or id — unknown names create the project. Tags are created as needed, and raw @Name mentions in the title/notes create Person blocks if missing.",
    {
      title: z.string().min(1),
      notes: z.string().optional(),
      available_date: z.string().optional(),
      due_date: z.string().optional(),
      status: z.string().optional(),
      project: z.string().optional(),
      projects: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
    },
    run(async (a) => {
      const ctx = await loadContext(api);
      const properties: Record<string, unknown> = { title: a.title };
      if (a.notes) properties.description = a.notes;
      if (a.available_date || a.due_date)
        properties[ctx.spanKey] = {
          ...(a.available_date ? { start: a.available_date } : {}),
          ...(a.due_date ? { end: a.due_date } : {}),
        };
      if (a.status) {
        if (!ctx.statusOptions.includes(a.status))
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
    "List/search tasks. All params optional and composable. status: open|done|... (or comma list); when: overdue|today|week|available|unscheduled; term: text search; project: title or id; list: a saved collection's title or id; region: a matrix region/row/column title within that list (e.g. \"Do\").",
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
          return tasks.slice(0, limit).map((b) => fmtTaskLine(ctx, b)).join("\n");
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
                if (!ctx.statusOptions.includes(s))
                  throw new Error(`Unknown status "${s}". Options: open, ${ctx.statusOptions.join(", ")}`);
                return prop(ctx.statusKey, "eq", s);
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
      const lines = blocks.slice(0, limit).map((b) => fmtTaskLine(ctx, b));
      const more = blocks.length > limit ? `\n…and ${blocks.length - limit} more (raise limit to see them).` : "";
      return lines.join("\n") + more;
    }),
  );

  tool(
    "task_info",
    "Get full details for one task by id or (unique) title.",
    { task: z.string().min(1) },
    run(async (a) => {
      const ctx = await loadContext(api);
      const b = await resolveTask(api, ctx, a.task);
      const info = await api.get<{ tags: { name: string }[]; inCollections: { id: string; label: string }[] }>(
        `/blocks/${b.id}/info`,
      );
      const p = b.properties as Record<string, unknown>;
      const span = (p[ctx.spanKey] ?? {}) as { start?: string; end?: string };
      const out = [
        `Task: ${String(p.title ?? "Untitled")}`,
        `Id: ${b.id}`,
        `Status: ${String(p[ctx.statusKey] ?? "—")}`,
        span.start ? `Available: ${fmtDate(span.start)}` : null,
        span.end ? `Due: ${fmtDate(span.end)}` : null,
        info.tags.length ? `Tags: ${info.tags.map((t) => `#${t.name}`).join(" ")}` : null,
        info.inCollections.length ? `Collections: ${info.inCollections.map((c) => c.label).join(", ")}` : null,
        p.description ? `Notes:\n${String(p.description)}` : null,
      ].filter(Boolean);
      if (ctx.projectRefKey && Array.isArray(p[ctx.projectRefKey]) && (p[ctx.projectRefKey] as string[]).length) {
        const names: string[] = [];
        for (const id of p[ctx.projectRefKey] as string[]) {
          try {
            const pb = await api.get<HermesBlock>(`/blocks/${id}`);
            names.push(String((pb.properties as Record<string, unknown>).title ?? id));
          } catch {
            names.push(id);
          }
        }
        out.splice(3, 0, `Projects: ${names.join(", ")}`);
      }
      return out.join("\n");
    }),
  );

  tool(
    "task_update",
    "Update a task by id or title. Only supplied fields change. Empty string clears a date. add/remove_tags and add/remove_projects adjust without replacing; unknown project names and new tags are created, and raw @Name mentions create Person blocks if missing.",
    {
      task: z.string().min(1),
      title: z.string().optional(),
      notes: z.string().optional(),
      status: z.string().optional(),
      available_date: z.string().optional(),
      due_date: z.string().optional(),
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
        p.description = a.notes;
        changed.push("notes");
      }
      if (a.status !== undefined) {
        if (!ctx.statusOptions.includes(a.status))
          throw new Error(`Unknown status "${a.status}". Options: ${ctx.statusOptions.join(", ")}`);
        p[ctx.statusKey] = a.status;
        changed.push(`status → ${a.status}`);
      }
      if (a.available_date !== undefined || a.due_date !== undefined) {
        const span = { ...((p[ctx.spanKey] ?? {}) as { start?: string; end?: string }) };
        if (a.available_date !== undefined) span.start = a.available_date || undefined;
        if (a.due_date !== undefined) span.end = a.due_date || undefined;
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
    "delete_task",
    "Delete a task permanently. Call without confirm first; repeat with confirm=true after the user confirms.",
    { task: z.string().min(1), confirm: z.boolean().optional() },
    run(async (a) => {
      const ctx = await loadContext(api);
      const b = await resolveTask(api, ctx, a.task);
      const title = String((b.properties as Record<string, unknown>).title ?? b.id);
      if (!a.confirm) return `This will permanently delete "${title}". Call again with confirm=true.`;
      await api.del(`/blocks/${b.id}`);
      return `Deleted "${title}".`;
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
      if (a.description) properties.description = a.description;
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
        p.description ? `About:\n${String(p.description)}` : null,
      ].filter(Boolean) as string[];
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

  tool(
    "delete_project",
    "Delete a project permanently (tasks are kept; they just lose the link). Two-step confirm.",
    { project: z.string().min(1), confirm: z.boolean().optional() },
    run(async (a) => {
      const ctx = await loadContext(api);
      const proj = await resolveProject(api, ctx, a.project);
      const title = String((proj.properties as Record<string, unknown>).title ?? proj.id);
      if (!a.confirm) return `This will permanently delete project "${title}". Call again with confirm=true.`;
      await api.del(`/blocks/${proj.id}`);
      return `Deleted project "${title}".`;
    }),
  );

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
            ? `${h.smart ? "smart " : ""}${h.document ? "spread" : h.matrix ? "matrix" : h.table ? "table" : "list"}`
            : (h.blockTypeId && typeName.get(h.blockTypeId)) || "block";
      return hits
        .map((h) => `- ${h.label} — ${kindOf(h)}${h.semantic ? " (semantic match)" : ""} [${h.id}]`)
        .join("\n");
    }),
  );

  tool(
    "block_get",
    "Read one block or collection by id (from search): content, properties, tags, and " +
      "containing collections. Collections also list their members.",
    { id: z.string().uuid() },
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
        const props = Object.entries(b.properties ?? {}).filter(
          ([k, v]) => k !== "title" && v != null && v !== "",
        );
        if (props.length) {
          lines.push("", "Properties:");
          for (const [k, v] of props) lines.push(`- ${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
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
          Object.assign(p, a.properties);
          changed.push(...Object.keys(a.properties));
        }
        if (a.title !== undefined || a.properties) body.properties = p;
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

  tool("list_types", "List the block types available (name, and whether it's a plain-text type).", {}, run(async () => {
    const types = await getTypes();
    return types.length ? types.map((t) => `- ${t.name}${t.isText ? " (text)" : ""}`).join("\n") : "No types.";
  }));

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

  tool("block_delete", "Permanently delete a block (or collection) by id.", { id: z.string() }, run(async (a) => {
    await api.del(`/blocks/${a.id}`);
    return `Deleted [${a.id}].`;
  }));

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
      for (let i = 0; i < n; i++) {
        const x = (i % cols) * (W + GAP);
        const y = Math.floor(i / cols) * (H + GAP);
        await api.post(`/collections/${c.id}/members`, { blockId: ids[i], context: { x, y, w: W, h: H } });
      }
      if (a.connect && n > 1) {
        const edges = ids.slice(0, -1).map((from, i) => ({ from, to: ids[i + 1] }));
        await api.patch(`/collections/${c.id}`, { canvas_edges: edges });
      }
      return `Created canvas "${a.title}" [${c.id}] with ${n} block${n === 1 ? "" : "s"}${a.connect ? ", connected in order" : ""}.`;
    }),
  );

  tool(
    "collection_members",
    "List the members of a collection (id or title) — their labels and ids, plus the matrix region if placed.",
    { collection: z.string() },
    run(async (a) => {
      const id = await resolveCollectionId(a.collection);
      const d = await api.get<{
        collection: { properties: Record<string, unknown> };
        members: { id: string; properties: Record<string, unknown>; content?: string | null; context?: Record<string, unknown> }[];
      }>(`/collections/${id}`);
      if (!d.members.length) return "No members.";
      const regions = Array.isArray(d.collection.properties.matrix_regions)
        ? (d.collection.properties.matrix_regions as { title?: string }[])
        : null;
      return d.members
        .map((m) => {
          const label = String(m.properties.title ?? "") || (m.content ?? "").split("\n")[0] || "Untitled";
          const r = m.context?.region;
          const region = regions && r != null ? ` — region "${regions[Number(r)]?.title || r}"` : "";
          return `- ${label}${region} [${m.id}]`;
        })
        .join("\n");
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

  for (const t of tools) {
    t.destructive = DESTRUCTIVE_TOOLS.has(t.name);
    t.readOnly = READONLY_TOOLS.has(t.name);
  }
  return tools;
}

/** MCP adapter: expose the shared tool registry to external agents, tagging
 *  destructive/read-only tools so MCP clients gate them natively. */
export function buildTools(server: McpServer, api: Api): void {
  for (const t of defineTools(api)) {
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
