import { and, eq, inArray, or, sql } from "drizzle-orm";
import { blockTypes, blocks, memberships } from "@hermes/db";
import type { FilterQuery, PropertySchema } from "@hermes/shared";
import { oneLineLabel } from "@hermes/shared";
import { db } from "../db.js";
import { runQuery } from "../collections/query.js";

/**
 * Connection graph for the Obsidian-style graph panel. BFS out from a root
 * block over the same relationship model the info pane uses — reference fields,
 * `block:`/`|` links, `@name` mentions (both directions), collection membership,
 * and canvas edges — to N generations, with a node cap so a dense vault can't
 * explode the payload.
 */

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  iconKey: string | null;
  iconColor: string | null;
  collection: boolean;
  gen: number;
}
export interface GraphEdge {
  from: string;
  to: string;
}
export interface GraphResult {
  root: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

const NODE_CAP = 160;
const LINK_RE = /block:([0-9a-fA-F-]{36})|\|([0-9a-fA-F-]{36})/g;

type Row = {
  id: string;
  blockTypeId: string | null;
  collectionKind: string | null;
  properties: unknown;
  content: string | null;
};
type TypeMeta = { name: string; isText: boolean; iconKey: string | null; iconColor: string | null; schema: PropertySchema | null };

const ROW_COLS = {
  id: blocks.id,
  blockTypeId: blocks.blockTypeId,
  collectionKind: blocks.collectionKind,
  properties: blocks.properties,
  content: blocks.content,
};

/** Strings to scan for links: content + every string-valued property. */
function stringsOf(props: Record<string, unknown>, content: string | null): string[] {
  const out = content ? [content] : [];
  for (const v of Object.values(props)) if (typeof v === "string") out.push(v);
  return out;
}

function nodeFrom(row: Row, gen: number, types: Map<string, TypeMeta>): GraphNode {
  const props = (row.properties ?? {}) as Record<string, unknown>;
  const label = oneLineLabel(props, row.content) || "Untitled";
  if (row.collectionKind) {
    return {
      id: row.id,
      label,
      type: `Collection · ${row.collectionKind}`,
      iconKey: (props.icon_key as string) ?? "folder",
      iconColor: (props.icon_color as string) ?? null,
      collection: true,
      gen,
    };
  }
  const t = row.blockTypeId ? types.get(row.blockTypeId) : undefined;
  if (!t) return { id: row.id, label, type: "Text", iconKey: "type", iconColor: null, collection: false, gen };
  return {
    id: row.id,
    label,
    type: t.isText ? "Text" : t.name,
    iconKey: t.isText ? "type" : t.iconKey,
    iconColor: t.isText ? null : t.iconColor,
    collection: false,
    gen,
  };
}

export async function buildGraph(userId: string, rootId: string, depth: number): Promise<GraphResult> {
  // Block types (icons + reference-field schemas) — small table, load once.
  const typeRows = await db
    .select({ id: blockTypes.id, name: blockTypes.name, isText: blockTypes.isText, iconKey: blockTypes.iconKey, iconColor: blockTypes.iconColor, schema: blockTypes.propertySchema })
    .from(blockTypes)
    .where(eq(blockTypes.ownerId, userId));
  const types = new Map<string, TypeMeta>(typeRows.map((t) => [t.id, t]));

  // Canvas adjacency (undirected) from every canvas's drawn edges — load once.
  const canvasRows = await db
    .select({ properties: blocks.properties })
    .from(blocks)
    .where(and(eq(blocks.ownerId, userId), eq(blocks.collectionKind, "canvas")));
  const canvasAdj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!canvasAdj.has(a)) canvasAdj.set(a, new Set());
    canvasAdj.get(a)!.add(b);
  };
  for (const c of canvasRows) {
    const edges = (c.properties as Record<string, unknown>).canvas_edges;
    if (!Array.isArray(edges)) continue;
    for (const e of edges as { from?: string; to?: string; live?: boolean }[]) {
      if (e.live === false || !e.from || !e.to) continue;
      if (e.from.startsWith("n:") || e.to.startsWith("n:")) continue;
      link(e.from, e.to);
      link(e.to, e.from);
    }
  }

  // Membership adjacency (block ↔ collection), covering explicit memberships
  // AND dynamic smart collections (which store no membership rows — evaluate
  // their query). Precomputed once so a note links to the collections it's in.
  const mem = await buildMembership(userId);

  const [rootRow] = await db.select(ROW_COLS).from(blocks).where(and(eq(blocks.id, rootId), eq(blocks.ownerId, userId))).limit(1);
  if (!rootRow) throw new Error("root not found");

  const nodes = new Map<string, GraphNode>([[rootId, nodeFrom(rootRow, 0, types)]]);
  const edgeSet = new Set<string>();
  const edges: GraphEdge[] = [];
  const addEdge = (from: string, to: string) => {
    if (from === to) return;
    const k = `${from}>${to}`;
    if (edgeSet.has(k)) return;
    edgeSet.add(k);
    edges.push({ from, to });
  };

  let truncated = false;
  let frontier = [rootId];
  for (let gen = 1; gen <= depth && frontier.length; gen++) {
    const { edges: found, meta } = await neighborsOf(userId, frontier, canvasAdj, types, mem);
    const next = new Set<string>();
    for (const e of found) {
      addEdge(e.from, e.to);
      // Add whichever endpoint(s) we haven't placed yet.
      for (const id of [e.from, e.to]) {
        if (nodes.has(id)) continue;
        if (nodes.size >= NODE_CAP) {
          truncated = true;
          continue;
        }
        const m = meta.get(id);
        if (m) {
          nodes.set(id, { ...m, gen });
          next.add(id);
        }
      }
    }
    frontier = [...next];
  }

  // Only keep edges whose endpoints both made the node cut.
  const kept = edges.filter((e) => nodes.has(e.from) && nodes.has(e.to));
  return { root: rootId, nodes: [...nodes.values()], edges: kept, truncated };
}

interface Membership {
  toColls: Map<string, Set<string>>; // block id → collections it belongs to
  toMembers: Map<string, Set<string>>; // collection id → member block ids
}
const SMART_QUERY_CAP = 80; // most dynamic collections to evaluate per graph

/**
 * Block ↔ collection adjacency across explicit memberships and dynamic smart
 * collections (whose members come from running their query, not from stored
 * rows). Bounded so a vault with many smart collections can't stall.
 */
async function buildMembership(userId: string): Promise<Membership> {
  const toColls = new Map<string, Set<string>>();
  const toMembers = new Map<string, Set<string>>();
  const add = (blockId: string, collId: string) => {
    if (!toColls.has(blockId)) toColls.set(blockId, new Set());
    toColls.get(blockId)!.add(collId);
    if (!toMembers.has(collId)) toMembers.set(collId, new Set());
    toMembers.get(collId)!.add(blockId);
  };

  const collections = await db
    .select({ id: blocks.id, properties: blocks.properties })
    .from(blocks)
    .where(and(eq(blocks.ownerId, userId), sql`${blocks.collectionKind} IS NOT NULL`));
  const collIds = collections.map((c) => c.id);

  // Explicit memberships (also covers snapshot smart collections).
  if (collIds.length) {
    const rows = await db
      .select({ blockId: memberships.blockId, collectionId: memberships.collectionId })
      .from(memberships)
      .where(inArray(memberships.collectionId, collIds));
    for (const r of rows) add(r.blockId, r.collectionId);
  }

  // Dynamic smart collections: members come from the live query.
  let evaluated = 0;
  for (const c of collections) {
    if (evaluated >= SMART_QUERY_CAP) break;
    const props = (c.properties ?? {}) as Record<string, unknown>;
    if (props.membership_mode !== "smart") continue;
    if (props.smart_mode === "snapshot") continue; // materialized above
    const filter = props.filter_query as FilterQuery | undefined;
    if (!filter) continue;
    evaluated++;
    try {
      const matches = await runQuery(userId, filter);
      for (const m of matches) add(m.id, c.id);
    } catch {
      /* skip a broken filter */
    }
  }
  return { toColls, toMembers };
}

/** All neighbors of a frontier set, as {from, neighbor-node} pairs. Batched. */
async function neighborsOf(
  userId: string,
  frontier: string[],
  canvasAdj: Map<string, Set<string>>,
  types: Map<string, TypeMeta>,
  mem: Membership,
): Promise<{ edges: GraphEdge[]; meta: Map<string, GraphNode> }> {
  const front = await db.select(ROW_COLS).from(blocks).where(and(eq(blocks.ownerId, userId), inArray(blocks.id, frontier)));
  const frontSet = new Set(frontier);

  // from-id → set of target ids (deduped), plus @name lookups to resolve.
  const out = new Map<string, Set<string>>();
  const addOut = (from: string, to: string) => {
    if (to === from) return;
    if (!out.has(from)) out.set(from, new Set());
    out.get(from)!.add(to);
  };
  const nameToFrom = new Map<string, Set<string>>(); // lowercased title → froms that @mention it
  const titleOfFront = new Map<string, string>(); // front id → its lowercased title (for inbound @)

  for (const row of front) {
    const props = (row.properties ?? {}) as Record<string, unknown>;
    const t = row.blockTypeId ? types.get(row.blockTypeId) : undefined;
    // reference-field values
    for (const f of t?.schema?.fields ?? []) {
      if (f.type !== "reference") continue;
      const v = props[f.key];
      if (Array.isArray(v)) for (const x of v) addOut(row.id, String(x));
      else if (typeof v === "string" && v) addOut(row.id, v);
    }
    // block:/| links in content + string props
    for (const s of stringsOf(props, row.content)) {
      let m: RegExpExecArray | null;
      LINK_RE.lastIndex = 0;
      while ((m = LINK_RE.exec(s)) !== null) {
        const tgt = m[1] ?? m[2];
        if (tgt) addOut(row.id, tgt);
      }
      // @Name mentions → resolve by title
      const at = /(^|\s)@([A-Za-z0-9][\w-]*)/g;
      let a: RegExpExecArray | null;
      while ((a = at.exec(s)) !== null) {
        if (!a[2]) continue;
        const name = a[2].replace(/_/g, " ").toLowerCase();
        if (!nameToFrom.has(name)) nameToFrom.set(name, new Set());
        nameToFrom.get(name)!.add(row.id);
      }
    }
    // canvas edges
    for (const other of canvasAdj.get(row.id) ?? []) addOut(row.id, other);
    const title = typeof props.title === "string" ? props.title.trim().toLowerCase() : "";
    if (title) titleOfFront.set(row.id, title);
  }

  // Resolve @name mentions (froms → titled blocks).
  if (nameToFrom.size) {
    const named = await db
      .select({ id: blocks.id, title: sql<string>`lower(${blocks.properties}->>'title')` })
      .from(blocks)
      .where(and(eq(blocks.ownerId, userId), sql`lower(${blocks.properties}->>'title') IN (${sql.join([...nameToFrom.keys()].map((n) => sql`${n}`), sql`, `)})`))
      .limit(200);
    for (const r of named) for (const from of nameToFrom.get(r.title) ?? []) addOut(from, r.id);
  }

  // Membership edges from the precomputed adjacency: collections a frontier
  // block is in, and members of a frontier collection.
  for (const fid of frontier) {
    for (const collId of mem.toColls.get(fid) ?? []) addOut(fid, collId);
    for (const memberId of mem.toMembers.get(fid) ?? []) addOut(fid, memberId);
  }

  // Inbound references: blocks that point at any frontier id via a bare-id
  // property, a `block:`/`|` link, or an `@title` mention.
  const conds = [
    ...frontier.map((fid) => sql`${blocks.properties}::text LIKE ${`%block:${fid}%`}`),
    ...frontier.map((fid) => sql`${blocks.properties}::text LIKE ${`%|${fid}%`}`),
    ...frontier.map((fid) => sql`${blocks.content} LIKE ${`%block:${fid}%`}`),
    ...frontier.map((fid) => sql`jsonb_path_exists(${blocks.properties}, '$.** ? (@ == $v)', jsonb_build_object('v', ${fid}::text))`),
  ];
  const titles = [...titleOfFront.values()];
  if (titles.length)
    conds.push(sql`lower(${blocks.properties}::text) ~ ${`@(${titles.map((tt) => tt.replace(/ /g, "_").replace(/[^\w]/g, ".")).join("|")})`}`);
  const inbound = await db
    .select(ROW_COLS)
    .from(blocks)
    .where(and(eq(blocks.ownerId, userId), sql`${blocks.collectionKind} IS DISTINCT FROM 'canvas'`, or(...conds)))
    .limit(200);
  for (const row of inbound) {
    if (frontSet.has(row.id)) continue;
    const props = (row.properties ?? {}) as Record<string, unknown>;
    const hay = stringsOf(props, row.content).join("\n");
    const propText = JSON.stringify(props);
    for (const fid of frontier) {
      if (hay.includes(`block:${fid}`) || hay.includes(`|${fid}`) || propText.includes(fid)) addOut(row.id, fid);
    }
    // @title inbound
    const inTitle = titleOfFront;
    for (const [fromFid, title] of inTitle) {
      const token = `@${title.replace(/ /g, "_")}`;
      if (hay.toLowerCase().includes(token)) addOut(row.id, fromFid);
    }
  }

  // Metadata for every id that appears in an edge — both endpoints, so inbound
  // ("linked from") blocks get placed too, not just outbound targets.
  const known = new Map<string, Row>(front.map((r) => [r.id, r]));
  for (const row of inbound) known.set(row.id, row);
  const involved = new Set<string>();
  for (const [from, set] of out) {
    involved.add(from);
    for (const id of set) involved.add(id);
  }
  const missing = [...involved].filter((id) => !known.has(id));
  for (let i = 0; i < missing.length; i += 300) {
    const chunk = missing.slice(i, i + 300);
    if (!chunk.length) break;
    const rows = await db.select(ROW_COLS).from(blocks).where(and(eq(blocks.ownerId, userId), inArray(blocks.id, chunk)));
    for (const r of rows) known.set(r.id, r);
  }

  const meta = new Map<string, GraphNode>();
  for (const id of involved) {
    const row = known.get(id);
    if (row) meta.set(id, nodeFrom(row, 0, types));
  }
  const edgesOut: GraphEdge[] = [];
  for (const [from, set] of out) {
    for (const to of set) {
      if (meta.has(from) && meta.has(to)) edgesOut.push({ from, to });
    }
  }
  return { edges: edgesOut, meta };
}
