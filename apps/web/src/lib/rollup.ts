import { normalizeRollup, type RollupConfig, type RollupLevel } from "@hermes/shared";
import { useEffect, useRef, useState } from "react";
import { ApiError, api, describeRequestFailure, type Block, type Collection, type Member } from "../api.ts";

/**
 * Resolving a rollup: the tree of blocks under a set of roots, one level at a
 * time.
 *
 * The shape is deliberately flat — a node knows its children, and the whole
 * thing is built breadth-first — because a level's query wants every parent at
 * that depth at once. Ten projects with ten tasks each is two requests, not
 * eleven.
 */
export interface RollupNode {
  block: Block;
  /** Which root this hangs under, so identical blocks in two branches stay apart. */
  path: string;
  depth: number;
  children: RollupNode[];
}

/** The block shape the children endpoint returns, plus the parent it hangs off. */
interface Edge {
  parentId: string;
  id: string;
  blockTypeId: string | null;
  collectionKind: string | null;
  content: string | null;
  properties: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

const asBlock = (e: Omit<Edge, "parentId">): Block => ({
  id: e.id,
  blockTypeId: e.blockTypeId ?? "",
  collectionKind: e.collectionKind,
  content: e.content,
  properties: e.properties,
  embeddedAt: null,
  embedPending: false,
  version: e.version,
  createdAt: e.createdAt,
  updatedAt: e.updatedAt,
});

const memberAsBlock = (m: Member): Block => ({
  id: m.id,
  blockTypeId: m.blockTypeId ?? "",
  collectionKind: m.collectionKind,
  content: m.content,
  properties: m.properties,
  embeddedAt: null,
  embedPending: false,
  version: m.version,
  createdAt: m.createdAt,
  updatedAt: m.updatedAt,
});

/** One level's children for every parent at that level, in one request. */
async function childrenOf(parents: string[], level: RollupLevel): Promise<Map<string, Block[]>> {
  const out = new Map<string, Block[]>();
  if (parents.length === 0) return out;
  const { edges } = await api.post<{ edges: Edge[] }>("/blocks/children", {
    parents,
    typeId: level.typeId ?? null,
    refKey: level.refKey ?? null,
    members: level.members ?? false,
  });
  for (const e of edges) {
    const list = out.get(e.parentId) ?? [];
    list.push(asBlock(e));
    out.set(e.parentId, list);
  }
  return out;
}

/**
 * Everything hanging off one block, however it was connected: any reference
 * property naming it, plus its members when it is a collection.
 *
 * The same query a rollup level runs, with the level left unconfigured — which
 * is what "connected to it" means when nobody has said which field to follow.
 */
export async function childrenOfBlock(parentId: string, members: boolean): Promise<Block[]> {
  const { edges } = await api.post<{ edges: Edge[] }>("/blocks/children", {
    parents: [parentId],
    typeId: null,
    refKey: null,
    members,
  });
  return edges.map(asBlock);
}

/**
 * The top row: a collection root contributes each of its members as a bucket,
 * a plain block is a bucket on its own.
 *
 * A root that yields nothing says why. Silently dropping it left the page
 * reading "nothing at the top level" over a collection that plainly has
 * members, with no way to tell an empty list from a deleted one.
 */
async function loadRoots(
  roots: string[],
  selfId: string,
): Promise<{ tops: Block[]; problems: string[] }> {
  const out: Block[] = [];
  const problems: string[] = [];
  for (const id of roots) {
    if (id === selfId) {
      problems.push("A rollup can't be its own top level.");
      continue;
    }
    try {
      const data = await api.get<{ collection: Collection; members: Member[] }>(`/collections/${id}`);
      const title = String(data.collection.properties.title ?? "That collection");
      if (data.members.length === 0) problems.push(`"${title}" has no members yet.`);
      out.push(...data.members.map(memberAsBlock));
      continue;
    } catch (err) {
      // Not a collection is expected — anything else is worth repeating.
      if (!(err instanceof ApiError) || err.status !== 404) {
        problems.push(`Couldn't read a top-level item — ${describeRequestFailure(err).message}`);
        continue;
      }
    }
    try {
      out.push(await api.get<Block>(`/blocks/${id}`));
    } catch {
      problems.push("A top-level item is no longer there — remove it below.");
    }
  }
  // The same block reached through two roots is still one bucket.
  const seen = new Set<string>();
  return { tops: out.filter((b) => (seen.has(b.id) ? false : (seen.add(b.id), true))), problems };
}

/** Build the whole tree, breadth-first, one request per level. */
export async function resolveRollup(
  config: RollupConfig,
  selfId: string,
): Promise<{ nodes: RollupNode[]; problems: string[] }> {
  const { tops, problems } = await loadRoots(config.roots, selfId);
  const nodes: RollupNode[] = tops.map((b) => ({ block: b, path: b.id, depth: 0, children: [] }));
  let frontier = nodes;
  for (let depth = 0; depth < config.levels.length && frontier.length > 0; depth++) {
    const level = config.levels[depth]!;
    const byParent = await childrenOf([...new Set(frontier.map((n) => n.block.id))], level);
    const next: RollupNode[] = [];
    for (const parent of frontier) {
      for (const child of byParent.get(parent.block.id) ?? []) {
        // A cycle (a block that references its own ancestor) would otherwise
        // expand forever. Stop where the branch repeats itself.
        if (parent.path.split("/").includes(child.id)) continue;
        const node: RollupNode = {
          block: child,
          path: `${parent.path}/${child.id}`,
          depth: depth + 1,
          children: [],
        };
        parent.children.push(node);
        next.push(node);
      }
    }
    frontier = next;
  }
  return { nodes, problems };
}

/** Load and keep a rollup's tree, re-resolving when its configuration changes. */
export function useRollup(configValue: unknown, selfId: string, nonce: number) {
  const config = normalizeRollup(configValue);
  const key = JSON.stringify(config);
  const [tree, setTree] = useState<RollupNode[] | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Only the newest resolve may write: configuration changes fast while it's
  // being edited, and a slow earlier answer must not land on top of a later one.
  const run = useRef(0);

  useEffect(() => {
    const mine = ++run.current;
    setError(null);
    if (config.roots.length === 0) {
      setTree([]);
      return;
    }
    void resolveRollup(config, selfId)
      .then((r) => {
        if (run.current !== mine) return;
        setTree(r.nodes);
        setProblems(r.problems);
      })
      .catch((err: unknown) => {
        if (run.current === mine) {
          setError(`Couldn't build this rollup — ${describeRequestFailure(err).message}`);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);

  return { config, tree, problems, error };
}

/** Every node in a tree, flattened — for counting and expand-all. */
export function walk(nodes: RollupNode[]): RollupNode[] {
  return nodes.flatMap((n) => [n, ...walk(n.children)]);
}
