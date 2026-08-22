import { and, asc, eq, gt, lt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { blocks, changes } from "@hermes/db";
import { db } from "../db.js";
import { authenticate, requireUser } from "../auth/middleware.js";

/**
 * A read surface for keeping an external mirror in step with this account.
 *
 * Every other listing endpoint here answers a screen: it returns the top N of
 * something and stops, because a screen only ever shows the top N. A mirror
 * needs the opposite guarantee — that it has seen everything, and can tell when
 * it hasn't — so it gets its own two routes rather than a pagination parameter
 * bolted onto queries whose contract is "the interesting ones".
 *
 * The pair works together: `/sync/blocks` walks the whole account once, and
 * `/sync/changes` reports what has moved since, reading the change log that
 * already backs live sync (migration 0027). Read-only, bearer-authenticated,
 * and touching nothing that existed before.
 */

/** The settle delay `events/watcher.ts` applies, and for the same reason. */
const SETTLE_MS = 200;

/** A block as a mirror needs it. */
const mirrorView = {
  id: blocks.id,
  blockTypeId: blocks.blockTypeId,
  collectionKind: blocks.collectionKind,
  content: blocks.content,
  properties: blocks.properties,
  blockTypeSchemaVersion: blocks.blockTypeSchemaVersion,
  version: blocks.version,
  archivedAt: blocks.archivedAt,
  createdAt: blocks.createdAt,
  updatedAt: blocks.updatedAt,
  // Tags come along rather than being fetched per block: a tag change is logged
  // against the block that carries it, so incremental sync already treats the
  // two as one thing, and a mirror that had to ask separately would make one
  // request per block to learn what a single join already knows.
  // Written out rather than interpolated: drizzle renders a column reference
  // inside a raw fragment as a bare name, and a bare `id` in here binds to
  // `tags t` — which has one — instead of the block outside. It correlates
  // against the wrong table and returns nothing, with no error to say so.
  tags: sql<string[]>`COALESCE((
    SELECT array_agg(t.name ORDER BY t.name)
    FROM block_tags bt JOIN tags t ON t.id = bt.tag_id
    WHERE bt.block_id = blocks.id
  ), '{}')`,
};

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  /** The change log's head, or 0 when nothing has ever been written. */
  const head = async (): Promise<number> => {
    const [row] = await db
      .select({ seq: sql<string | null>`COALESCE(MAX(${changes.seq}), 0)` })
      .from(changes);
    return Number(row?.seq ?? 0);
  };

  /**
   * One page of every block this account owns, ordered by id.
   *
   * Keyset rather than offset: the walk takes several requests and the account
   * is being written to throughout, and an offset counts rows that move under
   * it — a block inserted before the cursor shifts everything down one and the
   * page boundary skips a row that was never seen. An id the caller has already
   * passed can't move.
   *
   * Nothing is held back. Archived blocks come too, because whether to show one
   * is the mirror's decision to make and it can only make it if it knows they
   * exist; so do daily notes, which ordinary listings hide.
   */
  app.get("/sync/blocks", async (req) => {
    const userId = requireUser(req);
    const { after, limit } = z
      .object({
        after: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(2000).default(1000),
      })
      .parse(req.query);

    // Read the head before the page, never after: a block written while this
    // request runs must land in the change log at a seq the caller will still
    // ask for, and a head read afterwards could sit above a write the page
    // itself missed.
    const seq = await head();
    const rows = await db
      .select(mirrorView)
      .from(blocks)
      .where(and(eq(blocks.ownerId, userId), after ? gt(blocks.id, after) : sql`true`))
      .orderBy(asc(blocks.id))
      .limit(limit);

    return {
      blocks: rows,
      /**
       * Where to resume incremental reads — but only the FIRST page's value is
       * the safe one, and a caller should keep that and ignore every later one.
       * A block changed during the walk, at a position the walk has already
       * gone past, is logged above the first page's seq and below the last
       * page's; resuming from the later number steps over it.
       */
      seq,
      next: rows.length === limit ? (rows[rows.length - 1]?.id ?? null) : null,
    };
  });

  /**
   * What has changed since `since`, from the log the database writes itself.
   *
   * Deliberately thin: an id, an op, and the version afterwards. A mirror
   * re-reads the block rather than being handed it, because the log's job is to
   * say *that* something moved — one row per block per write, whatever the
   * write was — and a payload here would have to reproduce every shape the
   * blocks endpoint already returns.
   */
  app.get("/sync/changes", async (req) => {
    const userId = requireUser(req);
    const { since, limit } = z
      .object({
        since: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(2000).default(1000),
      })
      .parse(req.query);

    // Whether the caller's cursor still has continuous history behind it. Rows
    // are pruned by age (7 days), so a mirror that was away longer than that
    // can't be caught up by this route at all and needs the whole walk again.
    const [span] = await db
      .select({
        oldest: sql<string | null>`MIN(${changes.seq})`,
        head: sql<string | null>`pg_sequence_last_value(pg_get_serial_sequence('changes', 'seq')::regclass)`,
      })
      .from(changes);
    const oldest = span?.oldest == null ? null : Number(span.oldest);
    const headSeq = span?.head == null ? 0 : Number(span.head);
    // With rows retained, continuity holds when the caller's cursor reaches the
    // oldest one. With none retained, there is nothing to prove it with: an
    // empty log is either an account that has never been written to (the caller
    // is current, and `since` has nowhere to be behind) or one whose every row
    // aged out (the caller is behind and can't be told how far).
    const pruned = oldest === null ? since < headSeq : since + 1 < oldest;

    const rows = await db
      .select({
        seq: changes.seq,
        blockId: changes.blockId,
        op: changes.op,
        version: changes.version,
        at: changes.at,
      })
      .from(changes)
      .where(
        and(
          eq(changes.ownerId, userId),
          gt(changes.seq, since),
          // A bigserial is handed out when a row is written, not when it
          // commits, so seq 100 can land after 101 has already been read. A
          // reader tracking "everything above 101" would step straight over it.
          // Waiting a moment lets the stragglers arrive first.
          lt(changes.at, sql`now() - ${`${SETTLE_MS} milliseconds`}::interval`),
        ),
      )
      .orderBy(asc(changes.seq))
      .limit(limit);

    return {
      changes: rows.map((r) => ({ ...r, seq: Number(r.seq) })),
      nextSeq: rows.length ? Number(rows[rows.length - 1]!.seq) : since,
      /** More waiting beyond this page — ask again rather than sleeping. */
      more: rows.length === limit,
      pruned,
    };
  });
}
