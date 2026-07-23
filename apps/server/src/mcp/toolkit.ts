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

export function buildTools(server: McpServer, api: Api): void {
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

  server.tool(
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

  server.tool(
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

        // Matrix in a bound/date mode places live query MATCHES, not members.
        const matches =
          isMatrix && isSmart && bindKey
            ? await api.post<HermesBlock[]>("/blocks/query", { filterQuery: cprops.filter_query })
            : null;
        let pool: (HermesBlock & { context?: Record<string, unknown> })[];
        if (matches) pool = matches;
        else if (isMatrix && isSmart) {
          // Custom-grid smart matrix: visible cards are members the query still matches.
          const live = await api.post<HermesBlock[]>("/blocks/query", { filterQuery: cprops.filter_query });
          const liveIds = new Set(live.map((b) => b.id));
          pool = d.members.filter((m) => liveIds.has(m.id));
        } else pool = d.members;

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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool("project_list", "List active (non-archived) projects with open-task counts.", {}, run(async () => {
    const ctx = await loadContext(api);
    return projectLines(ctx, false);
  }));

  server.tool("project_archived", "List archived projects.", {}, run(async () => {
    const ctx = await loadContext(api);
    return projectLines(ctx, true);
  }));

  server.tool(
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

  server.tool(
    "project_archive",
    "Archive a project (status if the type has an archived option, otherwise an #archived tag). Two-step confirm.",
    { project: z.string().min(1), confirm: z.boolean().optional() },
    run((a) => setArchived(a.project, true, a.confirm)),
  );
  server.tool(
    "project_unarchive",
    "Unarchive a project. Two-step confirm.",
    { project: z.string().min(1), confirm: z.boolean().optional() },
    run((a) => setArchived(a.project, false, a.confirm)),
  );

  server.tool(
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

  server.tool("list_lists", "List saved collections (usable as task_find's `list` param).", {}, run(async () => {
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

  server.tool("tag_list", "List all tags.", {}, run(async () => {
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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
