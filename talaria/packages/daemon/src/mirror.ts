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
 * Blocks are stored as the objects `GET /interchange` returned, not as the
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
  kind: "create" | "complete" | "append" | "move" | "retitle";
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
  -- The number a write has to send back to be sure of what it is changing.
  -- Null for a membership mirrored before the producer issued one, and for a
  -- producer that does not version memberships at all; a write then sends
  -- nothing and is unprotected, which is the honest state rather than a
  -- guess that would be refused.
  version       INTEGER,
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

-- One vector per block, for Glance.
--
-- The model and dimension travel with the vector because a vector without them
-- is not merely uninformative, it is misleading: cosine similarity between
-- embeddings of two different models returns a plausible number rather than an
-- error. Changing model has to invalidate every row, and it can only do that if
-- every row says which model made it.
CREATE TABLE IF NOT EXISTS embeddings (
  block_id  TEXT PRIMARY KEY,
  model     TEXT NOT NULL,
  dim       INTEGER NOT NULL,
  -- Float32Array bytes. Kept as a blob rather than JSON: 768 floats is 3KB
  -- packed and about 15KB as text, times a library.
  vec       BLOB NOT NULL,
  -- What was embedded, so a block whose text has not changed is not re-embedded.
  source    TEXT NOT NULL
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

-- What the machine was doing, lately.
--
-- Deliberately not a log. Rows age out, nothing here is ever sent anywhere, and
-- nothing downstream may treat a row as a fact about the library: this is a
-- query key with a decay, and the moment a "session" becomes a stored object
-- somebody owns an activity log they will never read and will eventually regret.
--
-- No id, no primary key, no foreign key to blocks. A context row is not a thing.
CREATE TABLE IF NOT EXISTS context (
  at        TEXT NOT NULL,
  app       TEXT,
  title     TEXT,
  workspace TEXT,
  block     TEXT
);
CREATE INDEX IF NOT EXISTS context_at ON context (at);
`;

export interface ContextRow {
  at: string;
  app: string | null;
  title: string | null;
  workspace: string | null;
  block: string | null;
}

export class Mirror {
  private db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // WAL so a read never waits behind the sync loop's write.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.addColumns();
  }

  /**
   * Columns added to tables that already exist.
   *
   * `CREATE TABLE IF NOT EXISTS` builds the schema on a fresh machine and does
   * nothing at all on one that has synced before — so a column added here
   * arrives for new users and never for anybody else, and the bug is invisible
   * because everything else about the table is right.
   *
   * Bumping the seam does not help: a reseed re-reads the data into the table
   * that is already there. The column has to be added.
   *
   * Idempotent by asking first rather than by catching the duplicate-column
   * error, because a swallowed error here would hide the next thing too.
   */
  private addColumns(): void {
    const want: [string, string, string][] = [["memberships", "version", "INTEGER"]];
    for (const [table, column, type] of want) {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (cols.some((c) => c.name === column)) continue;
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
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
      memberships?: {
        collectionId: string;
        position: string | null;
        region: string | null;
        context: unknown;
        hidden: boolean;
        version?: number | null;
      }[];
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
      `INSERT INTO memberships (collection_id, block_id, position, region, context, hidden, version)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(collection_id, block_id) DO UPDATE SET
         position = excluded.position, region = excluded.region,
         context = excluded.context, hidden = excluded.hidden,
         version = excluded.version`,
    );
    this.db.exec("BEGIN");
    try {
      for (const r of rows) {
        stmt.run(r.id, r.raw, r.updatedAt, r.archived ? 1 : 0, r.title, r.body, r.kind, r.typeId, r.noteDate);
        if (r.memberships) {
          dropMem.run(r.id);
          for (const m of r.memberships) {
            addMem.run(
              m.collectionId,
              r.id,
              m.position,
              m.region,
              JSON.stringify(m.context ?? {}),
              m.hidden ? 1 : 0,
              m.version ?? null,
            );
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
  /**
   * Blocks that point at this one.
   *
   * A task names its project in a reference field, and a reference field is
   * user data — it may be called `project` here and something else in somebody
   * else's library, so keying on the name is the bug this codebase is built to
   * avoid. What is not user data is the shape: an id appearing inside another
   * block's properties *is* a reference, whatever the field is called.
   *
   * So the id is looked for in the raw JSON — narrowed in SQL, which is crude
   * and fast, then confirmed by walking the properties, because a substring
   * match on JSON would also hit an id that happened to be written in prose.
   */
  referencing(id: string, opts: { limit?: number } = {}): string[] {
    const rows = this.db
      .prepare("SELECT raw FROM blocks WHERE archived = 0 AND id <> ? AND raw LIKE ? LIMIT ?")
      .all(id, `%${id}%`, opts.limit ?? 200) as { raw: string }[];
    const mentions = (v: unknown): boolean => {
      if (typeof v === "string") return v === id;
      if (Array.isArray(v)) return v.some(mentions);
      if (v && typeof v === "object") return Object.values(v).some(mentions);
      return false;
    };
    return rows.filter((r) => {
      const props = (JSON.parse(r.raw) as { properties?: unknown }).properties;
      return mentions(props);
    }).map((r) => r.raw);
  }

  search(opts: {
    q?: string;
    kind?: string;
    /** A block *type* id, which is not the same question as `kind`: kind is the
     *  canonical shape a block was mapped to, typeId is the row the user made. */
    typeId?: string;
    includeArchived?: boolean;
    limit?: number;
  }): string[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (!opts.includeArchived) where.push("archived = 0");
    if (opts.kind) {
      where.push("kind = ?");
      params.push(opts.kind);
    }
    if (opts.typeId) {
      where.push("type_id = ?");
      params.push(opts.typeId);
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
  /**
   * Move a card locally, before the producer has been told.
   *
   * `region` here is the index the grid draws with; `name` is what the board
   * publishes. Both are written, because a row holding an index that says one
   * cell and a name that says another is a row that will be read both ways by
   * different callers — which it was, and the name went stale on every drag.
   */
  placeLocally(collectionId: string, blockId: string, region: number | null, name: string | null = null): void {
    const ctx = JSON.stringify(region === null ? {} : { region });
    this.db
      .prepare(
        `INSERT INTO memberships (collection_id, block_id, position, region, context, hidden)
         VALUES (?, ?, NULL, ?, ?, 0)
         ON CONFLICT(collection_id, block_id) DO UPDATE SET
           context = excluded.context, region = excluded.region`,
      )
      .run(collectionId, blockId, name, ctx);
  }

  /** Whether this block is already a member of that collection. */
  isMember(collectionId: string, blockId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS hit FROM memberships WHERE collection_id = ? AND block_id = ?")
      .get(collectionId, blockId);
    return row !== undefined;
  }

  /**
   * The version of a membership as the mirror last saw it.
   *
   * What a write sends back to be sure of what it is changing. Null when the
   * mirror has no row, and when the producer does not version memberships — a
   * write then sends nothing, which is unprotected and honest, rather than a
   * guess that would be refused.
   */
  memberVersion(collectionId: string, blockId: string): number | null {
    const row = this.db
      .prepare("SELECT version FROM memberships WHERE collection_id = ? AND block_id = ?")
      .get(collectionId, blockId) as { version: number | null } | undefined;
    return row?.version ?? null;
  }

  /** Which region a card currently sits in, if any. */
  regionOf(collectionId: string, blockId: string): number | null {
    const row = this.db
      .prepare("SELECT context FROM memberships WHERE collection_id = ? AND block_id = ?")
      .get(collectionId, blockId) as { context: string } | undefined;
    if (!row) return null;
    const v = (JSON.parse(row.context || "{}") as { region?: unknown }).region;
    return typeof v === "number" && Number.isInteger(v) ? v : null;
  }

  /** What's in a collection, in position order, with where each sits. */
  /**
   * Replace one collection's membership rows and nothing else.
   *
   * Distinct from what `putBlocks` does, and the distinction is the whole
   * reason this exists. That replaces the memberships of each *block* it is
   * given, because a full sync carries every collection a block is in. A read
   * of one collection carries one, so absorbing it that way would tell the
   * mirror that these blocks belong to nothing else — and quietly empty every
   * other board they were on.
   */
  replaceMembers(
    collectionId: string,
    rows: { blockId: string; position: string | null; region: string | null; context: unknown }[],
  ): void {
    const add = this.db.prepare(
      `INSERT INTO memberships (collection_id, block_id, position, region, context, hidden)
       VALUES (?, ?, ?, ?, ?, 0)
       ON CONFLICT(collection_id, block_id) DO UPDATE SET
         position = excluded.position, region = excluded.region, context = excluded.context`,
    );
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM memberships WHERE collection_id = ?").run(collectionId);
      for (const r of rows) {
        add.run(collectionId, r.blockId, r.position, r.region, JSON.stringify(r.context ?? {}));
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

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

  // ── embeddings ───────────────────────────────────────────────────────────

  /** What still needs a vector: everything whose source text has changed or was never done. */
  unembedded(model: string, limit = 200): { id: string; source: string }[] {
    return this.db
      .prepare(
        `SELECT b.id AS id, TRIM(b.title || ' ' || b.body) AS source
           FROM blocks b LEFT JOIN embeddings e ON e.block_id = b.id AND e.model = ?
          WHERE b.archived = 0 AND TRIM(b.title || ' ' || b.body) <> ''
            AND (e.block_id IS NULL OR e.source <> TRIM(b.title || ' ' || b.body))
          LIMIT ?`,
      )
      .all(model, limit) as { id: string; source: string }[];
  }

  putEmbedding(id: string, model: string, vec: Float32Array, source: string): void {
    this.db
      .prepare(
        `INSERT INTO embeddings (block_id, model, dim, vec, source) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(block_id) DO UPDATE SET
           model = excluded.model, dim = excluded.dim, vec = excluded.vec, source = excluded.source`,
      )
      .run(id, model, vec.length, new Uint8Array(vec.buffer.slice(0)), source);
  }

  /** Every vector for a model, with the block it belongs to. */
  embeddings(model: string): { id: string; vec: Float32Array }[] {
    const rows = this.db
      .prepare("SELECT block_id AS id, vec FROM embeddings WHERE model = ?")
      .all(model) as { id: string; vec: Uint8Array }[];
    return rows.map((r) => ({
      id: r.id,
      vec: new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4),
    }));
  }

  /** Forget every vector — after a model change, when none of them mean anything. */
  forgetEmbeddings(): number {
    const n = (this.db.prepare("SELECT COUNT(*) c FROM embeddings").get() as { c: number }).c;
    this.db.exec("DELETE FROM embeddings");
    return n;
  }

  embeddingStats(): { model: string; count: number }[] {
    return this.db
      .prepare("SELECT model, COUNT(*) AS count FROM embeddings GROUP BY model")
      .all() as { model: string; count: number }[];
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

  // ── context ──────────────────────────────────────────────────────────

  /**
   * A row as it comes out of SQLite, as a `ContextRow`.
   *
   * Mapped rather than asserted. `node:sqlite` hands back
   * `Record<string, SQLOutputValue>`, and telling the compiler it is something
   * more specific is the move that compiles today and hides a renamed column
   * later — the same reason `pending()` builds its objects by hand.
   */
  private static contextRow(r: Record<string, unknown>): ContextRow {
    const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
    return {
      at: String(r.at),
      app: s(r.app),
      title: s(r.title),
      workspace: s(r.workspace),
      block: s(r.block),
    };
  }

  /**
   * Write a context row, unless it says the same as the last one.
   *
   * A title-change event fires per keystroke in some editors, so the dedupe is
   * not an optimization — without it a minute of typing is a hundred rows
   * saying one thing, and the rolling window empties itself of everything
   * useful.
   */
  noteContext(row: Omit<ContextRow, "at">): void {
    const raw = this.db
      .prepare("SELECT at, app, title, workspace, block FROM context ORDER BY at DESC LIMIT 1")
      .get() as Record<string, unknown> | undefined;
    const last = raw ? Mirror.contextRow(raw) : null;
    if (
      last &&
      last.app === row.app &&
      last.title === row.title &&
      last.workspace === row.workspace &&
      last.block === row.block
    ) {
      return;
    }
    this.db
      .prepare("INSERT INTO context (at, app, title, workspace, block) VALUES (?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), row.app, row.title, row.workspace, row.block);
  }

  /** The rolling window, newest first. */
  recentContext(limit = 50): ContextRow[] {
    const rows = this.db
      .prepare("SELECT at, app, title, workspace, block FROM context ORDER BY at DESC LIMIT ?")
      .all(Math.min(Math.max(limit, 1), 500)) as Record<string, unknown>[];
    return rows.map(Mirror.contextRow);
  }

  /**
   * The most recent row whose app is not in `skip`.
   *
   * This is the whole point of keeping a record rather than asking the system:
   * once a picker is on screen it *is* the frontmost application, so "what am I
   * in" is unanswerable at the moment it is asked and trivially answerable from
   * a second ago.
   */
  workingContext(skip: string[]): ContextRow | null {
    const rows = this.db
      .prepare("SELECT at, app, title, workspace, block FROM context ORDER BY at DESC LIMIT 40")
      .all() as Record<string, unknown>[];
    return rows.map(Mirror.contextRow).find((r) => r.app && !skip.includes(r.app)) ?? null;
  }

  /** Drop everything older than the window. Called on every write. */
  pruneContext(before: string): void {
    this.db.prepare("DELETE FROM context WHERE at < ?").run(before);
  }

  /**
   * The block whose title is exactly this, if there is exactly one.
   *
   * Used to turn a window title into a block reference before the title is
   * stored — "was messaging Sherly Velez" is a strong retrieval signal, and an
   * id carries it better than the string does while keeping no record of who
   * was messaged.
   *
   * Deliberately strict, on three counts. Exact rather than fuzzy, because the
   * spec's own argument about stubs applies: name matching converges two
   * writers onto one roofer for free and gets two different Janes wrong.
   * Case-insensitive but not partial, because a partial match on a short title
   * hits half the library. And ambiguity resolves to nothing rather than to the
   * first row, because two blocks called the same thing is precisely the case
   * where guessing is worst.
   *
   * A miss is the normal outcome and costs nothing: the caller drops the title.
   */
  blockTitled(title: string): string | null {
    const t = title.trim();
    if (t.length < 3) return null;
    const rows = this.db
      .prepare("SELECT id FROM blocks WHERE archived = 0 AND lower(title) = lower(?) LIMIT 2")
      .all(t) as { id: string }[];
    // Destructured rather than indexed: `rows.length === 1` does not narrow
    // `rows[0]` under `noUncheckedIndexedAccess`, and the guard has to be on the
    // value anyway.
    const [only, second] = rows;
    return only && !second ? only.id : null;
  }

  /** Forget all of it, now. The off switch has to actually empty the drawer. */
  forgetContext(): number {
    const n = (this.db.prepare("SELECT COUNT(*) AS n FROM context").get() as { n: number }).n;
    this.db.exec("DELETE FROM context");
    return Number(n);
  }
}
