import { normalizeRollup, type RollupConfig, type RollupLevel } from "@hermes/shared";
import { useEffect, useRef, useState } from "react";
import { api, type Block, type Collection, type Member } from "../api.ts";

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
 * The top row: a collection root contributes each of its members as a bucket,
 * a plain block is a bucket on its own. A root that has since been deleted is
 * simply absent — a rollup naming something that's gone shows the rest rather
 * than failing.
 */
async function loadRoots(roots: string[]): Promise<Block[]> {
  const out: Block[] = [];
  for (const id of roots) {
    try {
      const data = await api.get<{ collection: Collection; members: Member[] }>(`/collections/${id}`);
      out.push(...data.members.map(memberAsBlock));
    } catch {
      try {
        out.push(await api.get<Block>(`/blocks/${id}`));
      } catch {
        /* gone — leave it out */
      }
    }
  }
  // The same block reached through two roots is still one bucket.
  const seen = new Set<string>();
  return out.filter((b) => (seen.has(b.id) ? false : (seen.add(b.id), true)));
}

/** Build the whole tree, breadth-first, one request per level. */
export async function resolveRollup(config: RollupConfig): Promise<RollupNode[]> {
  const tops = await loadRoots(config.roots);
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
  return nodes;
}

/** Load and keep a rollup's tree, re-resolving when its configuration changes. */
export function useRollup(configValue: unknown, nonce: number) {
  const config = normalizeRollup(configValue);
  const key = JSON.stringify(config);
  const [tree, setTree] = useState<RollupNode[] | null>(null);
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
    void resolveRollup(config)
      .then((t) => {
        if (run.current === mine) setTree(t);
      })
      .catch(() => {
        if (run.current === mine) setError("Couldn't build this rollup.");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);

  return { config, tree, error };
}

/** Every node in a tree, flattened — for counting and expand-all. */
export function walk(nodes: RollupNode[]): RollupNode[] {
  return nodes.flatMap((n) => [n, ...walk(n.children)]);
}
