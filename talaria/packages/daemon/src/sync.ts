import {
  regionName,
  seriesByObject,
  toCanonical,
  type Envelope,
  type InterchangeObject,
  type InterchangeType,
  type Series,
} from "@talaria/canonical";
import type { Hermes } from "./hermes.js";
import { discrepancies, GoneError, OfflineError, type Interchange } from "./interchange.js";
import type { Mirror } from "./mirror.js";

/**
 * Keeping the mirror in step, over the interchange binding.
 *
 * Two motions: a read of everything, and a read of what has moved since a
 * cursor. Both are the same route answering the same document — which is the
 * whole reason this file no longer knows what a Hermes is. It used to call
 * `/sync/blocks`, `/sync/changes` and `/block-types`, three routes belonging to
 * one producer; it now calls `GET /interchange`, and would work against any.
 *
 * Nothing here throws on a network failure. Being unable to reach Hermes is an
 * ordinary condition for this daemon — it is the condition the whole design is
 * arranged around — so it is reported, not raised.
 */



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
const SEAM_VERSION = "6-interchange";
const SEAM = "seam.version";

const CURSOR = "sync.cursor";
/** What the producer promised and did not deliver, as of the last full read. */
const MISMATCH = "sync.mismatch";
/** The local day the saved queries were last asked on. */
const QUERY_DAY = "sync.queryDay";
const LAST_OK = "sync.lastSuccessAt";
const FIRST_DONE = "sync.baselineDoneAt";

export type SyncOutcome =
  | { state: "ok"; changed: number; walked: boolean }
  | { state: "offline"; detail: string }
  | { state: "error"; detail: string };

export class Sync {
  constructor(
    private ix: Interchange,
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

  /**
   * Where the producer's answers stopped matching its manifest.
   *
   * Surfaced rather than absorbed. A daemon that silently copes with a surface
   * older than its claim is one that copes for months while somebody wonders
   * why ticking a task never sticks.
   */
  get mismatch(): { code: string; detail: string }[] {
    const raw = this.mirror.get(MISMATCH);
    return raw ? (JSON.parse(raw) as { code: string; detail: string }[]) : [];
  }

  /**
   * Opaque, and treated as such. It was a number when this talked to
   * `/sync/changes` and the temptation is to keep comparing it; the format says
   * it is a producer's private token, so it is stored and handed back and
   * nothing else.
   */
  get cursor(): string | null {
    return this.mirror.get(CURSOR);
  }

  /** The types, from the mirror, so this works offline. */
  private typeIndex(): Map<string, InterchangeType> {
    const map = new Map<string, InterchangeType>();
    for (const raw of this.mirror.types()) {
      const t = JSON.parse(raw) as InterchangeType;
      map.set(t.id, t);
    }
    return map;
  }

  /**
   * Store what an envelope holds.
   *
   * Memberships are inverted here: the format keeps them on the collection,
   * where they belong — a board knows who is on it — and the mirror keeps them
   * per block because that is how it is asked. The envelope always carries
   * collections whole, so replacing a block's set wholesale is safe and is the
   * only way a card that *left* a board stops being shown on it.
   */
  private store(env: Envelope): number {
    const types = this.typeIndex();
    const series = seriesByObject(env.series as Series[] | undefined);

    const byObject = new Map<
      string,
      { collectionId: string; position: string | null; region: string | null; context: unknown; hidden: boolean }[]
    >();
    for (const c of env.collections ?? []) {
      // A grid is drawn left to right, so everything that renders one counts in
      // cells. The format says names, because a cell is a fact about a renderer.
      // Both are kept: the name as it arrived, and the index this app draws
      // with — translated here, once, rather than in every view.
      const names = (c.placement?.regions ?? []).map(regionName);
      for (const m of c.members ?? []) {
        if (!m.object) continue;
        const index = m.region ? names.indexOf(m.region) : -1;
        byObject.set(m.object, [
          ...(byObject.get(m.object) ?? []),
          {
            collectionId: c.id,
            position: m.position ?? null,
            region: m.region ?? null,
            context: index >= 0 ? { ...(m.context ?? {}), region: index } : (m.context ?? {}),
            hidden: false,
          },
        ]);
      }
    }

    // A collection is an object here too, so the viewer can list boards without
    // a second concept. `kind` on the collection is the producer's word for the
    // shape of the view, which is furniture rather than meaning — passed through
    // and never interpreted for anything but layout.
    const rows: InterchangeObject[] = [
      ...(env.objects ?? []),
      ...((env.collections ?? []).map((c) => ({
        id: c.id,
        properties: { ...(c.properties ?? {}), title: c.name },
        collectionKind: c.kind,
        // Kept because a move has to be written as a region *name*, and this is
        // the only place the names are said. Without it the mirror knows a card
        // sits in region 2 and has nothing to call it.
        placement: c.placement,
        membership: c.membership,
      })) as InterchangeObject[]),
    ];

    this.mirror.putBlocks(
      rows.map((o) => {
        const collectionKind = (o.collectionKind as string | undefined) ?? null;
        const c = toCanonical(o, o.type ? types.get(o.type) : undefined, {
          appOrigin: this.appOrigin,
          collectionKind,
          series: series.get(o.id) ?? null,
        });
        return {
          id: o.id,
          raw: JSON.stringify({ ...o, canonical: c }),
          updatedAt: c.updatedAt,
          archived: Boolean(o.archived),
          title: c.title,
          body: c.body ?? "",
          kind: c.kind,
          typeId: o.type ?? null,
          noteDate: c.noteDate,
          memberships: byObject.get(o.id) ?? [],
        };
      }),
    );
    return rows.length;
  }

  /** Store the type table. */
  private storeTypes(env: Envelope): void {
    const types = env.types ?? [];
    if (types.length) this.mirror.putTypes(types.map((t) => ({ id: t.id, raw: JSON.stringify(t) })));
  }

  /**
   * Read the whole library.
   *
   * One request now, where the walk used to be a paged loop with a cursor taken
   * from the *first* page to avoid stepping over a block that moved mid-walk.
   * That care is no longer needed: the envelope is one answer taken at one
   * point, and the `cursor` in it is that point.
   */
  async baseline(): Promise<SyncOutcome> {
    try {
      const env = (await this.ix.read()) as Envelope;

      // Asked once per full read, not per tick: a manifest is a build constant
      // and does not move between polls, and the answers it is held against are
      // the ones a full read just produced.
      const said = await this.ix.conformance().catch(() => null);
      const gaps = said ? discrepancies(said, env as Record<string, unknown>) : [];
      this.mirror.set(MISMATCH, gaps.length ? JSON.stringify(gaps) : null);
      for (const g of gaps) console.error(`[talaria] ${g.code}: ${g.detail}`);

      this.storeTypes(env);
      const total = this.store(env);

      // Anything the mirror holds that the read didn't mention is gone. This is
      // what makes the change log's retention a performance boundary rather
      // than a correctness one: however long we were away, a full read
      // reconciles deletions by difference.
      const seen = new Set([
        ...(env.objects ?? []).map((o) => o.id),
        ...(env.collections ?? []).map((c) => c.id),
      ]);
      const vanished = this.mirror.idsNotIn(seen);
      this.mirror.deleteBlocks(vanished);

      await this.refreshQueries();
      const now = new Date().toISOString();
      if (env.cursor !== undefined) this.mirror.set(CURSOR, String(env.cursor));
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
   * Re-read named objects and store them now.
   *
   * Kept for the moment after a write lands: the next tick would carry the same
   * news, and "I ticked it and it didn't move" is not something to answer with
   * "wait thirty seconds". There is no read-by-id in the binding, so this asks
   * for what changed since the cursor — which is the same question, and returns
   * the write's own side effects into the bargain.
   */
  async refresh(_ids: string[]): Promise<void> {
    await this.catchUp();
  }

  /**
   * Has the local day rolled since the queries were last run?
   *
   * Local, not UTC: a saved query's "today" is the reader's today, and a mirror
   * that turned over at the wrong hour would be wrong for most of a working day
   * rather than briefly.
   */
  private dayTurned(): boolean {
    const today = new Date().toLocaleDateString("en-CA");
    return this.mirror.get(QUERY_DAY) !== today;
  }

  /**
   * Refresh the cached match set for every smart collection.
   *
   * The one place left that reaches past the binding, and the reason is in
   * LIMITS.md: the format says a collection's membership is computed and has no
   * way to say *what computes it*, and an envelope answers `materialized: false`
   * for exactly these. Hermes' evaluator is the only thing that knows, so
   * Hermes is asked — through Hermes' own route, named as such rather than
   * smuggled into the seam.
   */
  async refreshQueries(opts: { onlyMissing?: boolean } = {}): Promise<void> {
    for (const raw of this.mirror.search({ limit: 500 })) {
      const row = JSON.parse(raw) as {
        id: string;
        collectionKind?: string | null;
        properties?: Record<string, unknown>;
      };
      if (!row.collectionKind) continue;
      const q = row.properties?.filter_query;
      if (!q) continue;
      if (opts.onlyMissing && this.mirror.get(`query.${row.id}`) !== null) continue;
      try {
        const matched = await this.hermes.queryMatches(q);
        this.mirror.set(`query.${row.id}`, JSON.stringify(matched.map((b) => b.id)));
        this.mirror.set(QUERY_DAY, new Date().toLocaleDateString("en-CA"));
      } catch {
        // Keep the last answer. A stale match set is a far better board than no
        // board, and the freshness stamp already says how old everything is.
      }
    }
  }

  /** Throw away what we know and read it all again. */
  async full(): Promise<SyncOutcome> {
    this.mirror.set(SEAM, null);
    return this.baseline();
  }

  /** Apply everything that has moved since the cursor. */
  async catchUp(): Promise<SyncOutcome> {
    if (!this.everSynced) return this.baseline();
    // Everything stored was derived by rules that have since changed. A cursor
    // would only refresh objects that happen to move from here on, leaving the
    // rest wrong for as long as nobody touches them.
    if (this.seamStale) return this.baseline();
    const since = this.cursor;
    if (since === null) return this.baseline();

    try {
      const env = (await this.ix.read({ since })) as Envelope;
      this.storeTypes(env);

      // Last word wins, in both directions. A delete outranking every later row
      // was how a card could vanish and stay gone — a matrix move used to be
      // logged as a delete and an insert, and the insert was discarded for
      // arriving second.
      const gone = new Set<string>();
      for (const c of env.changes ?? []) {
        if (c.op === "delete") gone.add(c.object);
        else gone.delete(c.object);
      }

      const changed = this.store(env);
      this.mirror.deleteBlocks([...gone]);

      // A quiet tick still checks the query sets: a collection whose answer was
      // never fetched would otherwise stay empty for as long as nothing else in
      // the account moved. And all of them when the day has turned, since a
      // saved query is usually about dates and its answer expires at local
      // midnight whether or not a single object moved.
      const quiet = !changed && !gone.size;
      await this.refreshQueries({ onlyMissing: quiet && !this.dayTurned() });

      if (env.cursor !== undefined) this.mirror.set(CURSOR, String(env.cursor));
      this.mirror.set(LAST_OK, new Date().toISOString());
      return { state: "ok", changed: changed + gone.size, walked: false };
    } catch (err) {
      // The producer saying it cannot answer from that cursor. Not a failure —
      // the honest answer to being away longer than the log is kept, and the
      // signal to read everything again.
      if (err instanceof GoneError) return this.baseline();
      return err instanceof OfflineError
        ? { state: "offline", detail: err.message }
        : { state: "error", detail: (err as Error).message };
    }
  }
}
