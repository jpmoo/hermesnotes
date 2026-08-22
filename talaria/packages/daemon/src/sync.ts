import { toCanonical, type HermesTypeRow } from "@talaria/canonical";
import type { Hermes, SyncBlockRow } from "./hermes.js";
import { OfflineError } from "./hermes.js";
import type { Mirror } from "./mirror.js";

/**
 * Keeping the mirror in step.
 *
 * Two motions: a walk of the whole account, and a cursor over the change log.
 * The walk happens once (and again only when the cursor can no longer be
 * trusted); the cursor does everything after that.
 *
 * Nothing here throws on a network failure. Being unable to reach Hermes is an
 * ordinary condition for this daemon — it is the condition the whole design is
 * arranged around — so it is reported, not raised.
 */

/** How many changed ids are worth re-reading before walking is cheaper. */
const REWALK_THRESHOLD = 400;
/** Ids per batched refetch — the endpoint's own ceiling. */
const BATCH = 500;

/**
 * Bumped whenever the seam changes how it derives what the mirror stores.
 *
 * `kind`, `title` and `body` are extracted from each block at store time so a
 * search needn't parse every row — which means they are *derived*, and a change
 * to the mapper leaves every existing row holding an answer from the old rules.
 * Nothing would report that: search would just quietly return the wrong things
 * for blocks that hadn't happened to change since. So the version travels with
 * the mirror, and disagreeing with it forces a full re-walk.
 */
const SEAM_VERSION = "3";
const SEAM = "seam.version";

const CURSOR = "sync.cursor";
const LAST_OK = "sync.lastSuccessAt";
const FIRST_DONE = "sync.baselineDoneAt";

export type SyncOutcome =
  | { state: "ok"; changed: number; walked: boolean }
  | { state: "offline"; detail: string }
  | { state: "error"; detail: string };

export class Sync {
  constructor(
    private hermes: Hermes,
    private mirror: Mirror,
    private appOrigin: string,
  ) {}

  /** Whether the mirror has ever been filled. Distinct from "stale". */
  get everSynced(): boolean {
    return this.mirror.get(FIRST_DONE) !== null;
  }

  /** True when what's stored was derived by an older version of the seam. */
  get seamStale(): boolean {
    return this.everSynced && this.mirror.get(SEAM) !== SEAM_VERSION;
  }

  get lastSuccessAt(): string | null {
    return this.mirror.get(LAST_OK);
  }

  get cursor(): number {
    return Number(this.mirror.get(CURSOR) ?? 0);
  }

  /** The types, as the seam needs them. Read from the mirror, so this works offline. */
  private typeIndex(): Map<string, HermesTypeRow> {
    const map = new Map<string, HermesTypeRow>();
    for (const raw of this.mirror.types()) {
      const t = JSON.parse(raw) as HermesTypeRow;
      map.set(t.id, t);
    }
    return map;
  }

  /** Store rows, extracting what search needs by running them through the seam. */
  private store(rows: SyncBlockRow[]): void {
    const types = this.typeIndex();
    this.mirror.putBlocks(
      rows.map((row) => {
        const c = toCanonical(row, row.blockTypeId ? types.get(row.blockTypeId) : undefined, {
          appOrigin: this.appOrigin,
        });
        return {
          id: row.id,
          raw: JSON.stringify(row),
          updatedAt: row.updatedAt,
          archived: row.archivedAt !== null,
          title: c.title,
          body: c.body ?? "",
          kind: c.kind,
          typeId: row.blockTypeId,
          noteDate: c.noteDate,
        };
      }),
    );
  }

  /**
   * Walk the entire account.
   *
   * The cursor kept afterwards is the seq from the **first** page, never the
   * last. A block changed during the walk, at a position the walk has already
   * gone past, is logged above the first page's seq and below the last page's —
   * so resuming from the later number steps straight over it. Replaying a few
   * changes we already have costs nothing; missing one costs correctness.
   */
  async baseline(): Promise<SyncOutcome> {
    try {
      const types = await this.hermes.blockTypes();
      this.mirror.putTypes(types.map((t) => ({ id: t.id, raw: JSON.stringify(t) })));

      const seen = new Set<string>();
      let after: string | undefined;
      let firstSeq: number | null = null;
      let total = 0;
      for (;;) {
        const page = await this.hermes.blocksPage(after);
        if (firstSeq === null) firstSeq = page.seq;
        this.store(page.blocks);
        for (const b of page.blocks) seen.add(b.id);
        total += page.blocks.length;
        if (!page.next) break;
        after = page.next;
      }

      // Anything the mirror holds that the walk didn't mention is gone. This is
      // what makes the change log's seven-day retention a performance boundary
      // rather than a correctness one: however long we were away, a full walk
      // reconciles deletions by difference.
      const vanished = this.mirror.idsNotIn(seen);
      this.mirror.deleteBlocks(vanished);

      const now = new Date().toISOString();
      this.mirror.set(CURSOR, String(firstSeq ?? 0));
      this.mirror.set(SEAM, SEAM_VERSION);
      this.mirror.set(LAST_OK, now);
      if (!this.mirror.get(FIRST_DONE)) this.mirror.set(FIRST_DONE, now);
      return { state: "ok", changed: total + vanished.length, walked: true };
    } catch (err) {
      return err instanceof OfflineError
        ? { state: "offline", detail: err.message }
        : { state: "error", detail: (err as Error).message };
    }
  }

  /**
   * Re-read named blocks and store them now.
   *
   * Used straight after a write that went out live: the change log will carry
   * the same news on the next tick, but "I added it and it isn't there" is not
   * something to answer with "wait thirty seconds".
   */
  async refresh(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const page = await this.hermes.blocksByIds(ids);
    this.store(page.blocks);
    const returned = new Set(page.blocks.map((b) => b.id));
    this.mirror.deleteBlocks(ids.filter((id) => !returned.has(id)));
  }

  /** Apply everything the change log has for us since the cursor. */
  async catchUp(): Promise<SyncOutcome> {
    if (!this.everSynced) return this.baseline();
    // Everything stored was derived by rules that have since changed. A cursor
    // would only refresh blocks that happen to move from here on, leaving the
    // rest wrong for as long as nobody touches them.
    if (this.seamStale) return this.baseline();
    try {
      let since = this.cursor;
      const touched = new Set<string>();
      const gone = new Set<string>();
      for (;;) {
        const batch = await this.hermes.changes(since);
        if (batch.pruned) {
          // We were away longer than the log keeps. Nothing here can catch us
          // up, and pretending otherwise would leave a hole we'd never notice.
          return this.baseline();
        }
        for (const c of batch.changes) {
          if (c.op === "delete") {
            gone.add(c.blockId);
            touched.delete(c.blockId);
          } else {
            // A delete already seen in this drain outranks a later edit: rows
            // arrive in order, so the last word about a block is the true one.
            if (!gone.has(c.blockId)) touched.add(c.blockId);
          }
        }
        since = batch.nextSeq;
        if (!batch.more) break;
      }

      if (!touched.size && !gone.size) {
        this.mirror.set(CURSOR, String(since));
        this.mirror.set(LAST_OK, new Date().toISOString());
        return { state: "ok", changed: 0, walked: false };
      }

      // A burst big enough that re-reading it individually costs more than
      // reading everything — a tag rename across a whole notebook, say.
      if (touched.size > REWALK_THRESHOLD) return this.baseline();

      const ids = [...touched];
      for (let i = 0; i < ids.length; i += BATCH) {
        const page = await this.hermes.blocksByIds(ids.slice(i, i + BATCH));
        this.store(page.blocks);
        // Asked-for ids that came back absent were deleted between the log
        // saying so and us asking. Treat them as gone rather than as stale.
        const returned = new Set(page.blocks.map((b) => b.id));
        for (const id of ids.slice(i, i + BATCH)) if (!returned.has(id)) gone.add(id);
      }
      this.mirror.deleteBlocks([...gone]);

      this.mirror.set(CURSOR, String(since));
      this.mirror.set(LAST_OK, new Date().toISOString());
      return { state: "ok", changed: touched.size + gone.size, walked: false };
    } catch (err) {
      return err instanceof OfflineError
        ? { state: "offline", detail: err.message }
        : { state: "error", detail: (err as Error).message };
    }
  }
}
