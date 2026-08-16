import { and, asc, gt, lt, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { changes } from "@hermes/db";
import { db, isDbReady } from "../db.js";
import { publishChange, type ChangeEvent } from "./hub.js";

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
 * Turn the change log into live-sync events.
 *
 * Polled rather than pushed through LISTEN/NOTIFY: it costs one indexed read
 * every 300ms while somebody is actually watching, needs no second connection
 * held open, and keeps working on a Postgres that has no notify to give.
 */
export function startChangeWatcher(log: FastifyBaseLogger): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  // Where we've read up to. Null means "find the head first" — starting from
  // zero would replay the whole table at whoever connected.
  let cursor: number | null = null;
  let lastPrune = 0;

  const tick = async () => {
    if (stopped) return;
    try {
      if (isDbReady()) {
        if (listeners === 0) {
          // Nobody to tell. Forget where we'd read up to, so the next connection
          // starts from the head rather than being handed every change made
          // while the app sat closed — these are "go and look again" nudges, and
          // a page that has just loaded has already looked. It also means an
          // idle server asks the database nothing at all.
          cursor = null;
        } else {
          if (cursor === null) {
            const [row] = await db
              .select({ max: sql<number | null>`COALESCE(MAX(${changes.seq}), 0)` })
              .from(changes);
            cursor = Number(row?.max ?? 0);
          }
          await drain();
        }
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
        version: changes.version,
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
    // so is still one piece of news per block. Rows arrive in order, so the
    // last word about a block is the current one — except that a delete
    // outranks everything: a block that has gone is not a block to refetch.
    const perUser = new Map<string, Map<string, ChangeEvent>>();
    for (const r of rows) {
      let forUser = perUser.get(r.ownerId);
      if (!forUser) perUser.set(r.ownerId, (forUser = new Map()));
      if (forUser.get(r.blockId)?.kind === "delete") continue;
      forUser.set(
        r.blockId,
        r.op === "delete"
          ? { kind: "delete", id: r.blockId }
          : { kind: "block", id: r.blockId, version: r.version },
      );
    }
    for (const [userId, blocksChanged] of perUser) {
      for (const ev of blocksChanged.values()) publishChange(userId, ev);
    }
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
