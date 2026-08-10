import { and, eq, gt, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import {
  attachments,
  blockEmbeddings,
  blockTags,
  blocks,
  padEmbedding,
  tags,
  userSettings,
} from "@hermes/db";
import { EMBEDDING_INDEX_DIM } from "@hermes/db/schema";
import {
  DAILY_NOTE_TYPE_ID,
  filterUsesDailyNotes,
  normalizeFilter,
  resolveDateToken,
  userLocalNow,
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
export async function semanticIds(userId: string, value: string, floor: number): Promise<string[]> {
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
    case "blockType": {
      // The Daily Note sentinel isn't a real type — match by the today_note
      // marker, and only notes with actual scratchpad text (skip the empty
      // day-notes auto-created just by visiting a day).
      const isDaily = c.typeId === DAILY_NOTE_TYPE_ID;
      const match = isDaily
        ? sql`(jsonb_exists(${blocks.properties}, 'today_note') AND coalesce(${blocks.content}, '') ~ '[^[:space:]]')`
        : eq(blocks.blockTypeId, c.typeId);
      // A block with no type at all counts as "not this type", which a bare NOT
      // would drop on the NULL comparison.
      return c.op === "isNot"
        ? sql`NOT COALESCE(${match}, false)`
        : match;
    }
    case "created": {
      const d = new Date(resolveDateToken(c.date, now));
      return c.op === "before" ? lt(blocks.createdAt, d) : gt(blocks.createdAt, d);
    }
    case "edited": {
      const d = new Date(resolveDateToken(c.date, now));
      return c.op === "before" ? lt(blocks.updatedAt, d) : gt(blocks.updatedAt, d);
    }
    case "tag": {
      const has = sql`EXISTS (SELECT 1 FROM ${blockTags} bt JOIN ${tags} tg ON tg.id = bt.tag_id WHERE bt.block_id = ${blocks.id} AND tg.name = ${c.tag})`;
      return c.op === "exclude" ? sql`NOT ${has}` : has;
    }
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
          // Ordered comparisons require a non-empty value on BOTH sides: an
          // empty stored value sorts before every date, and an empty compare
          // value (`> ''`) would otherwise match every non-empty row. Guard both.
          return v ? sql`(${p} <> '' AND ${p} < ${v})` : sql`false`;
        case "gt":
          return v ? sql`(${p} <> '' AND ${p} > ${v})` : sql`false`;
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
    case "hasAttachment": {
      const ex = sql`EXISTS (SELECT 1 FROM ${attachments} a WHERE a.block_id = ${blocks.id})`;
      return c.has ? ex : sql`NOT ${ex}`;
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

/** Run a smart-collection filter (a group tree), returning matching blocks.
 * `archived` flips the whole query to the Archive view (archived blocks only);
 * every normal caller leaves it false. */
/**
 * The moment a query's relative dates ("today", "today+7", "now") count from.
 * Normally the user's actual now; on a Today page it's that page's day, so an
 * embedded list of "due today" means due on the day you're reading, not the day
 * you happen to be reading it. The clock time carries over so "now" still has
 * an hour to compare against.
 */
function asOfNow(tz: string | null, asOf?: string | null): Date {
  const now = userLocalNow(tz);
  if (!asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return now;
  const [y, m, d] = asOf.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d, now.getHours(), now.getMinutes(), now.getSeconds());
}

/**
 * Most rows one query will return. A board of more than this stops being usable
 * before the number matters, and an unbounded query ("every block") would pour
 * the whole database into a grid. Callers that show the result should say when
 * they're showing a slice of it — see runQueryCounted.
 */
export const QUERY_LIMIT = 500;

export async function runQuery(
  userId: string,
  filter: FilterQuery,
  archived = false,
  asOf?: string | null,
): Promise<QueriedBlock[]> {
  return (await runQueryCounted(userId, filter, archived, asOf)).rows;
}

/**
 * The same query, plus how many blocks actually match. The count costs a second
 * query, so it's only run when the first came back full — that's the only case
 * where the answer differs from the rows in hand, and the only case where
 * anyone needs telling.
 */
export async function runQueryCounted(
  userId: string,
  filter: FilterQuery,
  archived = false,
  asOf?: string | null,
): Promise<{ rows: QueriedBlock[]; total: number; limit: number }> {
  const root = normalizeFilter(filter);
  const semConds: Condition[] = [];
  collectSemantic(root, semConds);
  const sem = new Map<Condition, string[]>();
  await Promise.all(
    semConds.map(async (c) => {
      if (c.kind === "semantic") sem.set(c, await semanticIds(userId, c.value, c.floor));
    }),
  );

  const scopeConds: SQL[] = [
    eq(blocks.ownerId, userId),
    sql`${blocks.collectionKind} IS NULL`,
    // Weekly-review reflections are system blocks — always hidden.
    sql`NOT jsonb_exists(${blocks.properties}, 'review_reflection')`,
    // Archived blocks never appear in a normal query (smart collections, task
    // tools, All blocks, graph membership all flow through here); the Archive
    // page inverts this to show only archived ones.
    archived ? sql`${blocks.archivedAt} IS NOT NULL` : sql`${blocks.archivedAt} IS NULL`,
  ];
  // Today scratchpad notes are also system blocks and normally hidden — UNLESS
  // the query explicitly opts in via the Daily Note type.
  if (!filterUsesDailyNotes(root)) {
    scopeConds.push(sql`NOT jsonb_exists(${blocks.properties}, 'today_note')`);
  }
  const scope = and(...scopeConds);
  // Relative-date tokens resolve against the requester's timezone, not the box's.
  const [tzRow] = await db
    .select({ tz: userSettings.timezone })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  const combined = groupSql(root, sem, asOfNow(tzRow?.tz ?? null, asOf));

  const where = and(scope, combined);
  const rows = await db
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
    .where(where)
    .orderBy(sql`${blocks.updatedAt} DESC`)
    .limit(QUERY_LIMIT);

  if (rows.length < QUERY_LIMIT) return { rows, total: rows.length, limit: QUERY_LIMIT };
  const [counted] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(blocks)
    .where(where);
  return { rows, total: Number(counted?.n ?? rows.length), limit: QUERY_LIMIT };
}
