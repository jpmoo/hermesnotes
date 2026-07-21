import { and, eq, gt, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { blockEmbeddings, blockTags, blocks, padEmbedding, tags, userSettings } from "@hermes/db";
import { EMBEDDING_INDEX_DIM } from "@hermes/db/schema";
import {
  normalizeFilter,
  resolveDateToken,
  type Condition,
  type FilterGroup,
  type FilterQuery,
} from "@hermes/shared";
import { db } from "../db.js";
import { embed } from "../ollama/client.js";

export interface QueriedBlock {
  id: string;
  blockTypeId: string | null;
  content: string | null;
  properties: Record<string, unknown>;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Block ids whose embedding is within the similarity floor of the query text. */
async function semanticIds(userId: string, value: string, floor: number): Promise<string[]> {
  const [s] = await db
    .select({ url: userSettings.ollamaUrl, model: userSettings.embedModel })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  if (!s?.url || !s?.model || !value.trim()) return [];
  let vec: number[];
  try {
    vec = padEmbedding(await embed(s.url, s.model, value), EMBEDDING_INDEX_DIM);
  } catch {
    return [];
  }
  const lit = `[${vec.join(",")}]`;
  // pgvector cosine distance = 1 - similarity; floor on similarity => distance <= 1 - floor.
  const rows = await db
    .select({ blockId: blockEmbeddings.blockId })
    .from(blockEmbeddings)
    .where(
      and(
        eq(blockEmbeddings.ownerId, userId),
        sql`(${blockEmbeddings.embedding} <=> ${lit}::vector(${sql.raw(String(EMBEDDING_INDEX_DIM))})) <= ${1 - floor}`,
      ),
    )
    .limit(1000);
  return rows.map((r) => r.blockId);
}

function conditionSql(c: Condition, sem: Map<Condition, string[]>, now: Date): SQL {
  switch (c.kind) {
    case "blockType":
      return eq(blocks.blockTypeId, c.typeId);
    case "created": {
      const d = new Date(resolveDateToken(c.date, now));
      return c.op === "before" ? lt(blocks.createdAt, d) : gt(blocks.createdAt, d);
    }
    case "edited": {
      const d = new Date(resolveDateToken(c.date, now));
      return c.op === "before" ? lt(blocks.updatedAt, d) : gt(blocks.updatedAt, d);
    }
    case "tag":
      return sql`EXISTS (SELECT 1 FROM ${blockTags} bt JOIN ${tags} tg ON tg.id = bt.tag_id WHERE bt.block_id = ${blocks.id} AND tg.name = ${c.tag})`;
    case "text": {
      const like = `%${c.value}%`;
      return sql`(${blocks.properties}->>'title' ILIKE ${like} OR ${blocks.content} ILIKE ${like} OR ${blocks.embedSource} ILIKE ${like})`;
    }
    case "property": {
      // Dotted keys address a nested json value, e.g. a datespan's
      // "available.start" -> properties -> 'available' ->> 'start'.
      const dot = c.key.indexOf(".");
      const p =
        dot > 0
          ? sql`${blocks.properties}->${c.key.slice(0, dot)}->>${c.key.slice(dot + 1)}`
          : sql`${blocks.properties}->>${c.key}`;
      // Relative date tokens (today, today+1, now) resolve at query time.
      const v = resolveDateToken(c.value ?? "", now);
      switch (c.op) {
        case "eq":
          return sql`${p} = ${v}`;
        case "neq":
          return sql`${p} IS DISTINCT FROM ${v}`;
        case "contains":
          return sql`${p} ILIKE ${`%${v}%`}`;
        case "lt":
          return sql`${p} < ${v}`;
        case "gt":
          return sql`${p} > ${v}`;
        case "empty":
          return sql`(${p} IS NULL OR ${p} = '')`;
        case "notEmpty":
          return sql`(${p} IS NOT NULL AND ${p} <> '')`;
        default:
          return sql`true`;
      }
    }
    case "semantic": {
      const ids = sem.get(c) ?? [];
      return ids.length ? inArray(blocks.id, ids) : sql`false`;
    }
  }
}

function groupSql(g: FilterGroup, sem: Map<Condition, string[]>, now: Date): SQL {
  const parts = g.items.map((it) =>
    it.kind === "group" ? groupSql(it, sem, now) : conditionSql(it, sem, now),
  );
  if (parts.length === 0) return sql`true`;
  return (g.match === "any" ? or(...parts) : and(...parts)) ?? sql`true`;
}

function collectSemantic(g: FilterGroup, out: Condition[]): void {
  for (const it of g.items) {
    if (it.kind === "group") collectSemantic(it, out);
    else if (it.kind === "semantic") out.push(it);
  }
}

/** Run a smart-collection filter (a group tree), returning matching blocks. */
export async function runQuery(userId: string, filter: FilterQuery): Promise<QueriedBlock[]> {
  const root = normalizeFilter(filter);
  const semConds: Condition[] = [];
  collectSemantic(root, semConds);
  const sem = new Map<Condition, string[]>();
  await Promise.all(
    semConds.map(async (c) => {
      if (c.kind === "semantic") sem.set(c, await semanticIds(userId, c.value, c.floor));
    }),
  );

  const scope = and(eq(blocks.ownerId, userId), sql`${blocks.collectionKind} IS NULL`);
  const combined = groupSql(root, sem, new Date());

  return db
    .select({
      id: blocks.id,
      blockTypeId: blocks.blockTypeId,
      content: blocks.content,
      properties: blocks.properties,
      version: blocks.version,
      createdAt: blocks.createdAt,
      updatedAt: blocks.updatedAt,
    })
    .from(blocks)
    .where(and(scope, combined))
    .orderBy(sql`${blocks.updatedAt} DESC`)
    .limit(500);
}
