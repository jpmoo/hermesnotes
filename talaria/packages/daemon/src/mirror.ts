import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The local mirror.
 *
 * Every read Talaria serves comes from here and never from the network, which
 * is the whole reason the daemon exists: a system layer that intermittently
 * returns nothing is worse than no system layer at all, because trust in it
 * doesn't degrade — it collapses, and doesn't come back.
 *
 * Blocks are stored as the JSON that `/sync/blocks` returned, not as the
 * canonical form. The mapping is cheap, the canonical shape will change more
 * often than the wire shape, and a mirror holding derived data would need
 * rebuilding every time the seam moves. Search columns are extracted alongside
 * so a query doesn't have to parse everything.
 *
 * Every `node:sqlite` call in the project lives in this file. The module is
 * still marked experimental, so if its API moves, swapping in better-sqlite3 is
 * a change to one file rather than to the daemon.
 */

export interface StoredBlock {
  id: string;
  /** The raw `/sync/blocks` row, as JSON. */
  raw: string;
  updatedAt: string;
  archived: boolean;
}

export interface QueuedIntent {
  id: number;
  kind: "create" | "complete" | "append" | "move";
  /** What the user meant, as JSON — never the document that would result. */
  payload: string;
  /** The block version this was based on, when there was one. */
  baseVersion: number | null;
  createdAt: string;
  /** Set when replay stopped and needs a person: the reason, in words. */
  parkedReason: string | null;
  attempts: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS blocks (
  id           TEXT PRIMARY KEY,
  raw          TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  archived     INTEGER NOT NULL DEFAULT 0,
  -- Extracted for search so a query needn't parse every row.
  title        TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  kind         TEXT NOT NULL DEFAULT 'other',
  type_id      TEXT,
  note_date    TEXT
);
CREATE INDEX IF NOT EXISTS blocks_kind ON blocks (kind);
CREATE INDEX IF NOT EXISTS blocks_note_date ON blocks (note_date);

-- Where each block sits in each collection it belongs to. Its own table rather
-- than a field on the block, because every question worth asking of it goes the
-- other way round: not "which collections is this in" but "what is in this
-- collection, and where".
CREATE TABLE IF NOT EXISTS memberships (
  collection_id TEXT NOT NULL,
  block_id      TEXT NOT NULL,
  position      TEXT,
  region        TEXT,
  context       TEXT NOT NULL DEFAULT '{}',
  hidden        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, block_id)
);
CREATE INDEX IF NOT EXISTS memberships_collection ON memberships (collection_id);

CREATE TABLE IF NOT EXISTS block_types (
  id   TEXT PRIMARY KEY,
  raw  TEXT NOT NULL
);

-- Single-row table. Everything the daemon needs to know about where it got to.
CREATE TABLE IF NOT EXISTS state (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,
  payload       TEXT NOT NULL,
  base_version  INTEGER,
  created_at    TEXT NOT NULL,
  parked_reason TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0
);
`;

export class Mirror {
  private db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // WAL so a read never waits behind the sync loop's write.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ── state ────────────────────────────────────────────────────────────────

  get(key: string): string | null {
    const row = this.db.prepare("SELECT v FROM state WHERE k = ?").get(key) as { v: string } | undefined;
    return row?.v ?? null;
  }

  set(key: string, value: string | null): void {
    if (value === null) {
      this.db.prepare("DELETE FROM state WHERE k = ?").run(key);
      return;
    }
    this.db.prepare("INSERT INTO state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(key, value);
  }

  // ── blocks ───────────────────────────────────────────────────────────────

  /** Insert or replace, in one transaction. Used by both baseline and catch-up. */
  putBlocks(
    rows: {
      id: string; raw: string; updatedAt: string; archived: boolean; title: string; body: string;
      kind: string; typeId: string | null; noteDate: string | null;
      memberships?: { collectionId: string; position: string | null; region: string | null; context: unknown; hidden: boolean }[];
    }[],
  ): void {
    if (!rows.length) return;
    const stmt = this.db.prepare(
      `INSERT INTO blocks (id, raw, updated_at, archived, title, body, kind, type_id, note_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         raw = excluded.raw, updated_at = excluded.updated_at, archived = excluded.archived,
         title = excluded.title, body = excluded.body, kind = excluded.kind,
         type_id = excluded.type_id, note_date = excluded.note_date`,
    );
    // A block's memberships are replaced wholesale, never merged: the payload is
    // the complete set, so anything not in it has been removed, and merging
    // would leave a card sitting in a collection it was taken out of.
    const dropMem = this.db.prepare("DELETE FROM memberships WHERE block_id = ?");
    const addMem = this.db.prepare(
      `INSERT INTO memberships (collection_id, block_id, position, region, context, hidden)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(collection_id, block_id) DO UPDATE SET
         position = excluded.position, region = excluded.region,
         context = excluded.context, hidden = excluded.hidden`,
    );
    this.db.exec("BEGIN");
    try {
      for (const r of rows) {
        stmt.run(r.id, r.raw, r.updatedAt, r.archived ? 1 : 0, r.title, r.body, r.kind, r.typeId, r.noteDate);
        if (r.memberships) {
          dropMem.run(r.id);
          for (const m of r.memberships) {
            addMem.run(m.collectionId, r.id, m.position, m.region, JSON.stringify(m.context ?? {}), m.hidden ? 1 : 0);
          }
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  deleteBlocks(ids: string[]): void {
    if (!ids.length) return;
    const dropMem = this.db.prepare("DELETE FROM memberships WHERE block_id = ?");
    const stmt = this.db.prepare("DELETE FROM blocks WHERE id = ?");
    this.db.exec("BEGIN");
    try {
      for (const id of ids) {
        dropMem.run(id);
        stmt.run(id);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Ids the mirror holds that the given set doesn't — deleted while we were away. */
  idsNotIn(seen: Set<string>): string[] {
    const rows = this.db.prepare("SELECT id FROM blocks").all() as { id: string }[];
    return rows.map((r) => r.id).filter((id) => !seen.has(id));
  }

  rawBlock(id: string): string | null {
    const row = this.db.prepare("SELECT raw FROM blocks WHERE id = ?").get(id) as { raw: string } | undefined;
    return row?.raw ?? null;
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM blocks").get() as { n: number };
    return Number(row.n);
  }

  /**
   * Search. Literal matching only — semantic search lives on the server, needs
   * an embedding model, and is exactly the thing that must not be reached for
   * when the network is down.
   */
  search(opts: { q?: string; kind?: string; includeArchived?: boolean; limit?: number }): string[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (!opts.includeArchived) where.push("archived = 0");
    if (opts.kind) {
      where.push("kind = ?");
      params.push(opts.kind);
    }
    if (opts.q?.trim()) {
      where.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')");
      const like = `%${opts.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      params.push(like, like);
    }
    params.push(Math.min(Math.max(opts.limit ?? 50, 1), 500));
    const rows = this.db
      .prepare(
        `SELECT raw FROM blocks ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...params) as { raw: string }[];
    return rows.map((r) => r.raw);
  }

  /**
   * Move a card locally, so the board redraws before the network answers.
   *
   * A card from the drawer has no membership row yet, so this inserts one:
   * dragging it into a region is the moment it joins the collection.
   */
  placeLocally(collectionId: string, blockId: string, region: number | null): void {
    const ctx = JSON.stringify(region === null ? {} : { region });
    this.db
      .prepare(
        `INSERT INTO memberships (collection_id, block_id, position, region, context, hidden)
         VALUES (?, ?, NULL, NULL, ?, 0)
         ON CONFLICT(collection_id, block_id) DO UPDATE SET context = excluded.context`,
      )
      .run(collectionId, blockId, ctx);
  }

  /** Whether this block is already a member of that collection. */
  isMember(collectionId: string, blockId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS hit FROM memberships WHERE collection_id = ? AND block_id = ?")
      .get(collectionId, blockId);
    return row !== undefined;
  }

  /** What's in a collection, in position order, with where each sits. */
  membersOf(collectionId: string): { raw: string; region: string | null; position: string | null; context: string }[] {
    return this.db
      .prepare(
        `SELECT b.raw AS raw, m.region AS region, m.position AS position, m.context AS context
         FROM memberships m JOIN blocks b ON b.id = m.block_id
         WHERE m.collection_id = ? AND m.hidden = 0
         ORDER BY m.position`,
      )
      .all(collectionId) as { raw: string; region: string | null; position: string | null; context: string }[];
  }

  // ── types ────────────────────────────────────────────────────────────────

  putTypes(rows: { id: string; raw: string }[]): void {
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM block_types");
      const stmt = this.db.prepare("INSERT INTO block_types (id, raw) VALUES (?, ?)");
      for (const r of rows) stmt.run(r.id, r.raw);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  types(): string[] {
    return (this.db.prepare("SELECT raw FROM block_types").all() as { raw: string }[]).map((r) => r.raw);
  }

  // ── queue ────────────────────────────────────────────────────────────────

  enqueue(kind: QueuedIntent["kind"], payload: unknown, baseVersion: number | null): number {
    const info = this.db
      .prepare("INSERT INTO queue (kind, payload, base_version, created_at) VALUES (?, ?, ?, ?)")
      .run(kind, JSON.stringify(payload), baseVersion, new Date().toISOString());
    return Number(info.lastInsertRowid);
  }

  pending(): QueuedIntent[] {
    const rows = this.db
      .prepare("SELECT * FROM queue ORDER BY id ASC")
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      kind: String(r.kind) as QueuedIntent["kind"],
      payload: String(r.payload),
      baseVersion: r.base_version === null ? null : Number(r.base_version),
      createdAt: String(r.created_at),
      parkedReason: r.parked_reason === null ? null : String(r.parked_reason),
      attempts: Number(r.attempts),
    }));
  }

  dequeue(id: number): void {
    this.db.prepare("DELETE FROM queue WHERE id = ?").run(id);
  }

  park(id: number, reason: string): void {
    this.db.prepare("UPDATE queue SET parked_reason = ?, attempts = attempts + 1 WHERE id = ?").run(reason, id);
  }

  unpark(id: number): void {
    this.db.prepare("UPDATE queue SET parked_reason = NULL WHERE id = ?").run(id);
  }

  bumpAttempt(id: number): void {
    this.db.prepare("UPDATE queue SET attempts = attempts + 1 WHERE id = ?").run(id);
  }
}
