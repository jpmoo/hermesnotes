import { and, asc, gt, lt, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { changes } from "@hermes/db";
import { db, isDbReady } from "../db.js";
import { publishChange } from "./hub.js";

/** How often the log is read while anyone is listening. */
const TICK_MS = 300;
/** Rows per read. A burst bigger than this is drained on the next tick. */
const BATCH = 500;
/**
 * How long a row must have been sitting there before it's published.
 *
 * A bigserial is handed out when the row is written, not when it commits, so a
 * slow transaction can commit seq 100 after seq 101 has already gone out — and
 * a reader tracking "everything above 101" would step straight over it. Waiting
 * a moment lets those land first. The lag is imperceptible next to a network
 * round trip, and the same guarantee is what a sync cursor would need.
 */
const SETTLE_MS = 200;

/** Anything older than this is no longer news to anybody. */
const KEEP_DAYS = 7;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

/** Open SSE connections, so an idle server doesn't poll for nobody. */
let listeners = 0;

export function noteListenerOpened(): void {
  listeners += 1;
}
export function noteListenerClosed(): void {
  listeners = Math.max(0, listeners - 1);
}

/**
 * Temporary, while the log runs alongside the URL-sniffing hook it replaces.
 *
 * The hook announces the block id it can read out of the request path; this
 * records that so the watcher can say which changes only the log saw. When the
 * quiet ones have been watched for a while and the hook comes out, this goes
 * with it.
 */
const sniffed = new Map<string, number>();
const SNIFF_WINDOW_MS = 5_000;

export function noteUrlSniffed(blockId: string): void {
  // The hook says "" for a create, whose id isn't in the URL — it can't name
  // what changed, so there's nothing to match a log row against.
  if (blockId) sniffed.set(blockId, Date.now());
}

/** Was this block's change also seen by the old hook, moments ago? */
function wasSniffed(blockId: string): boolean {
  const at = sniffed.get(blockId);
  if (at == null) return false;
  if (Date.now() - at > SNIFF_WINDOW_MS) {
    sniffed.delete(blockId);
    return false;
  }
  return true;
}

/**
 * Turn the change log into live-sync events.
 *
 * Polled rather than pushed through LISTEN/NOTIFY: it costs one indexed read
 * every 300ms while somebody is actually watching, needs no second connection
 * held open, and keeps working on a Postgres that has no notify to give.
 */
export function startChangeWatcher(log: FastifyBaseLogger): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  // Where we've read up to. Null until the first tick finds out — starting from
  // zero would replay the entire table into every connected client on a restart.
  let cursor: number | null = null;
  let lastPrune = 0;

  const tick = async () => {
    if (stopped) return;
    try {
      if (isDbReady()) {
        if (cursor === null) {
          const [row] = await db
            .select({ max: sql<number | null>`COALESCE(MAX(${changes.seq}), 0)` })
            .from(changes);
          cursor = Number(row?.max ?? 0);
        }
        if (listeners > 0) await drain();
        const now = Date.now();
        if (now - lastPrune > PRUNE_EVERY_MS) {
          lastPrune = now;
          await prune();
        }
      }
    } catch (err) {
      log.error({ err }, "change watcher tick error");
    }
    if (!stopped) timer = setTimeout(tick, TICK_MS);
  };

  const drain = async () => {
    const rows = await db
      .select({
        seq: changes.seq,
        ownerId: changes.ownerId,
        blockId: changes.blockId,
        op: changes.op,
      })
      .from(changes)
      .where(
        and(
          gt(changes.seq, cursor ?? 0),
          lt(changes.at, sql`now() - ${`${SETTLE_MS} milliseconds`}::interval`),
        ),
      )
      .orderBy(asc(changes.seq))
      .limit(BATCH);
    if (rows.length === 0) return;
    cursor = Number(rows[rows.length - 1]!.seq);

    // One message per block, not per write. Renaming a tag or resolving a
    // placeholder touches every note that named it, and a hundred rows saying
    // so is still one piece of news per block. A delete outranks an edit: a
    // block that has gone is not a block to go and refetch.
    const perUser = new Map<string, Map<string, "block" | "delete">>();
    for (const r of rows) {
      let forUser = perUser.get(r.ownerId);
      if (!forUser) perUser.set(r.ownerId, (forUser = new Map()));
      const kind = r.op === "delete" ? "delete" : "block";
      if (kind === "delete" || !forUser.has(r.blockId)) forUser.set(r.blockId, kind);
    }
    const quiet: string[] = [];
    for (const [userId, blocksChanged] of perUser) {
      for (const [id, kind] of blocksChanged) {
        publishChange(userId, { kind, id });
        if (!wasSniffed(id)) quiet.push(id);
      }
    }
    // The whole point, said out loud while the two run side by side: these are
    // changes nobody was told about before. Expect a note re-seeded on a GET, a
    // day reset, a placeholder resolved across several notes, a swept note.
    if (quiet.length) log.info({ blocks: quiet }, "change log saw writes the URL hook missed");
  };

  const prune = async () => {
    await db.delete(changes).where(lt(changes.at, sql`now() - ${`${KEEP_DAYS} days`}::interval`));
  };

  log.info("change watcher started");
  timer = setTimeout(tick, TICK_MS);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
