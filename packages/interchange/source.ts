/**
 * Where a real library comes from, wherever you happen to be running.
 *
 * These checks were written on a laptop and read Talaria's local mirror, which
 * is the one place the data was to hand. That is exactly backwards on the
 * machine that actually holds it: the server has the database and no mirror, so
 * the two scripts that exercise real data were the two that could not run where
 * the real data lives.
 *
 * So: Postgres when `DATABASE_URL` is set, the mirror otherwise. Same rows
 * either way, and neither script has to care.
 */
import { existsSync } from "node:fs";
import type { HermesBlock, HermesMembership, HermesSeries, HermesType } from "./src/types.js";

export interface Library {
  types: HermesType[];
  blocks: HermesBlock[];
  memberships: HermesMembership[];
  seriesRows: HermesSeries[];
  from: string;
}

const MIRROR = `${process.env.HOME}/Library/Application Support/Talaria/mirror.sqlite`;

export async function loadLibrary(): Promise<Library> {
  if (process.env.DATABASE_URL) return fromPostgres(process.env.DATABASE_URL);
  if (existsSync(MIRROR)) return fromMirror();
  throw new Error(
    "No library to read. Set DATABASE_URL to point at Hermes' database, or run this where Talaria's mirror lives.",
  );
}

async function fromPostgres(url: string): Promise<Library> {
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, { max: 1 });
  try {
    // Whoever holds the most blocks. A single-user install has one account and a
    // shared one has an obvious main; either way the check says whose library it
    // just read rather than picking silently.
    const [owner] = await sql<{ owner_id: string; n: number }[]>`
      SELECT owner_id, COUNT(*)::int AS n FROM blocks GROUP BY owner_id ORDER BY n DESC LIMIT 1`;
    if (!owner) throw new Error("No blocks in the database.");
    const id = owner.owner_id;

    const types = await sql<{ id: string; name: string; is_text: boolean; property_schema: unknown }[]>`
      SELECT id, name, is_text, property_schema FROM block_types WHERE owner_id = ${id}`;
    const blocks = await sql<Record<string, unknown>[]>`
      SELECT id, block_type_id, collection_kind, content, properties, archived_at,
             created_at, updated_at, series_id
        FROM blocks WHERE owner_id = ${id}`;
    const mem = await sql<Record<string, unknown>[]>`
      SELECT m.collection_id, m.block_id, m.position, m.context
        FROM memberships m JOIN blocks b ON b.id = m.block_id AND b.owner_id = ${id}`;
    const seriesRows = await sql<{ id: string; rule: Record<string, unknown> }[]>`
      SELECT id, rule FROM series WHERE owner_id = ${id}`;

    return {
      from: `postgres (owner ${id.slice(0, 8)}, ${owner.n} blocks)`,
      types: types.map((t) => ({
        id: t.id,
        name: t.name,
        isText: t.is_text,
        propertySchema: (t.property_schema ?? null) as HermesType["propertySchema"],
      })),
      blocks: blocks.map((b) => ({
        id: String(b.id),
        blockTypeId: (b.block_type_id as string) ?? null,
        collectionKind: (b.collection_kind as string) ?? null,
        content: (b.content as string) ?? null,
        properties: (b.properties ?? {}) as Record<string, unknown>,
        archivedAt: b.archived_at ? new Date(b.archived_at as string).toISOString() : null,
        createdAt: new Date(b.created_at as string).toISOString(),
        updatedAt: new Date(b.updated_at as string).toISOString(),
        seriesId: (b.series_id as string) ?? null,
      })),
      memberships: mem.map((m) => ({
        collectionId: String(m.collection_id),
        blockId: String(m.block_id),
        position: (m.position as string) ?? null,
        context: (m.context ?? {}) as Record<string, unknown>,
      })),
      seriesRows,
    };
  } finally {
    await sql.end();
  }
}

async function fromMirror(): Promise<Library> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(MIRROR);
  const raw = (q: string) => (db.prepare(q).all() as { raw: string }[]).map((r) => JSON.parse(r.raw));
  const blocks = raw("select raw from blocks") as HermesBlock[];
  return {
    from: `Talaria's mirror (${blocks.length} blocks)`,
    types: raw("select raw from block_types") as HermesType[],
    blocks,
    memberships: (
      db.prepare("select collection_id, block_id, position, context from memberships").all() as {
        collection_id: string;
        block_id: string;
        position: string | null;
        context: string;
      }[]
    ).map((m) => ({
      collectionId: m.collection_id,
      blockId: m.block_id,
      position: m.position,
      context: JSON.parse(m.context ?? "{}") as Record<string, unknown>,
    })),
    // The mirror does not carry series rows — only the link on each block — so a
    // run from here reports what it cannot see rather than pretending.
    seriesRows: [],
  };
}
