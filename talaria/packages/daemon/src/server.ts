import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { bodyFieldKey, optionLabel } from "@hermes/shared";
import { toCanonical, type HermesTypeRow } from "@talaria/canonical";
import type { Config } from "./config.js";
import { HermesError, OfflineError, type Hermes } from "./hermes.js";
import type { Mirror } from "./mirror.js";
import { Queue, type Intent } from "./queue.js";
import { describe, freshnessOf } from "./staleness.js";
import type { Sync } from "./sync.js";

/**
 * The daemon's local face.
 *
 * HTTP over a Unix socket rather than a port: the filesystem is then the
 * authorization model, which matters for a process holding a Hermes access key
 * — a localhost port is reachable by every process and every web page on the
 * machine. It also stays debuggable by hand, which XPC would not be:
 *
 *   curl --unix-socket ~/Library/Application\ Support/Talaria/talaria.sock \
 *        'http://x/blocks?q=roofer'
 */
/**
 * How a collection was told to group, if it was.
 *
 * The setting lives in a different place per kind — a rollup keeps its
 * arrangement under `rollup_views.top`, everything else under `view_state` —
 * and reads either "type" or "prop:<key>".
 */
function groupByOf(props: Record<string, unknown>, kind: string | null): string | null {
  const src =
    kind === "rollup"
      ? ((props.rollup_views as Record<string, unknown> | undefined)?.top as Record<string, unknown> | undefined)
      : (props.view_state as Record<string, unknown> | undefined);
  const g = src?.groupBy;
  return typeof g === "string" && g ? g : null;
}

/** A number, or null — canvas geometry arrives as numbers or not at all. */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function buildServer(deps: {
  config: Config;
  mirror: Mirror;
  hermes: Hermes;
  sync: Sync;
  socketPath: string;
}): FastifyInstance {
  const { config, mirror, hermes, sync } = deps;
  const queue = new Queue(hermes, mirror);
  const app = Fastify({ logger: false });

  /**
   * The type a bare `add` should use.
   *
   * Hermes resolves a missing `blockTypeId` to the *text* type, and a text type
   * keeps its body in `content` and discards properties — so asking for a task
   * without naming a type would quietly produce an empty note. Resolving it here
   * also means an offline create is classified correctly in the mirror straight
   * away rather than sitting as `other` until it syncs.
   *
   * Found by shape, not by name, for the same reason the seam does it that way.
   */
  const defaultTypeId = (want: "task" | "note"): string | undefined => {
    const all = [...types().values()];
    if (want === "note") return all.find((t) => t.isText)?.id;
    return (
      all.find((t) => t.builtin && t.name.toLowerCase() === "task")?.id ??
      all.find(
        (t) => !t.isText && t.propertySchema?.status_field && t.propertySchema.complete_values?.length,
      )?.id
    );
  };

  const types = (): Map<string, HermesTypeRow> => {
    const m = new Map<string, HermesTypeRow>();
    for (const raw of mirror.types()) {
      const t = JSON.parse(raw) as HermesTypeRow;
      m.set(t.id, t);
    }
    return m;
  };

  /** Every answer says how much it can be trusted. Nothing serves silently stale. */
  const envelope = <T>(data: T) => {
    const f = freshnessOf(sync.lastSuccessAt, sync.everSynced);
    return {
      data,
      freshness: f,
      syncedAt: sync.lastSuccessAt,
      note: describe(f, sync.lastSuccessAt),
    };
  };

  const canon = (raws: string[]) => {
    const idx = types();
    return raws.map((raw) => {
      const row = JSON.parse(raw);
      return toCanonical(row, row.blockTypeId ? idx.get(row.blockTypeId) : undefined, {
        appOrigin: config.origin,
      });
    });
  };

  app.get("/health", async () => {
    const f = freshnessOf(sync.lastSuccessAt, sync.everSynced);
    return {
      ok: true,
      freshness: f,
      syncedAt: sync.lastSuccessAt,
      cursor: sync.cursor,
      blocks: mirror.count(),
      queued: mirror.pending().length,
      parked: mirror.pending().filter((q) => q.parkedReason).length,
      origin: config.origin,
      socket: deps.socketPath,
    };
  });

  /**
   * Everything that can be silently wrong, asked out loud.
   *
   * Most of what this layer depends on fails quietly — a revoked key, a socket
   * nothing is bound to, a permission never granted, a mirror that stopped
   * updating a week ago. None of those announce themselves; they just make
   * Spotlight a bit emptier than it should be. So there is one command whose
   * whole job is to go and look.
   */
  app.get("/doctor", async () => {
    const checks: { name: string; ok: boolean; detail: string }[] = [];
    const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

    add("config", true, `${config.origin} (poll ${config.pollSeconds}s)`);
    add("socket", true, `${deps.socketPath} (mode 0600)`);

    const typeCount = mirror.types().length;
    add("block types", typeCount > 0, typeCount ? `${typeCount} mirrored` : "none — has a sync ever finished?");

    const f = freshnessOf(sync.lastSuccessAt, sync.everSynced);
    add("mirror", f !== "never" && f !== "cold", `${mirror.count()} blocks, ${describe(f, sync.lastSuccessAt)}`);

    const reach = await hermes.reachable();
    add("hermes", reach.ok, reach.detail);

    const q = mirror.pending();
    const parked = q.filter((x) => x.parkedReason);
    add("queue", parked.length === 0, parked.length ? `${parked.length} parked, needs a decision` : `${q.length} waiting`);

    return { ok: checks.every((c) => c.ok), checks };
  });

  /** Reads never touch the network — this is the whole point of the mirror. */
  app.get("/blocks", async (req) => {
    const q = z
      .object({
        q: z.string().optional(),
        kind: z.string().optional(),
        archived: z.coerce.boolean().optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      })
      .parse(req.query);
    return envelope(
      canon(mirror.search({ q: q.q, kind: q.kind, includeArchived: q.archived, limit: q.limit })),
    );
  });

  app.get("/blocks/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const raw = mirror.rawBlock(id);
    if (!raw) return reply.code(404).send({ error: "not in the mirror" });
    return envelope(canon([raw])[0]);
  });

  /**
   * The mirror as Spotlight wants it.
   *
   * Flattened here rather than in Swift because this is where the block types
   * and the seam already are, and because Swift is the part that is slow and
   * awkward to change (brief §3, §8). The app that consumes this only has to
   * copy fields into a CSSearchableItemAttributeSet.
   *
   * Archived blocks are left out: archive means "not part of my working set",
   * so an archived block in Spotlight is the index disagreeing with the app.
   * `epoch` lets a caller skip the work when nothing has moved.
   */
  app.get("/spotlight", async () => {
    const items = canon(mirror.search({ limit: 500 }))
      .filter((b) => !b.archivedAt)
      .map((b) => ({
        id: b.id,
        title: b.title,
        // Enough to recognise it by in a result row, without pasting a whole
        // note into the index.
        description: (b.body ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
        /**
         * The second line of a Spotlight result.
         *
         * Leads with where it came from, because a result row appearing next to
         * files, mail and contacts has to say what kind of thing it is before it
         * says anything else — "Task" alone could be anything on the machine.
         * The type's own name is used, so a renamed type reads the way the user
         * named it.
         */
        subtitle: [`Hermes ${b.typeName}`, (b.body ?? "").replace(/\s+/g, " ").trim()]
          .filter(Boolean)
          .join("  ·  ")
          .slice(0, 300),
        kind: b.kind,
        typeName: b.typeName,
        tags: b.tags,
        url: b.url,
        appUrl: b.appUrl,
        createdAt: b.createdAt,
        updatedAt: b.updatedAt,
      }));
    return { epoch: sync.cursor, count: items.length, items };
  });

  /** Every collection in the mirror, for the picker. */
  app.get("/boards", async () =>
    envelope(
      canon(mirror.search({ limit: 500 }))
        .filter((b) => b.collectionKind !== null)
        .sort((a, b) => a.title.localeCompare(b.title))
        .map((b) => ({ id: b.id, title: b.title, kind: b.collectionKind })),
    ),
  );

  /**
   * A matrix collection, laid out.
   *
   * Flattened here rather than in Swift, for the reason everything else is:
   * the placement rules are Hermes' and they live on this side. A region is a
   * numeric index into a cols x rows grid, and a member's `context.region`
   * says which cell it is in — a member with no region has been added but not
   * yet placed, which is a real state and gets its own bucket rather than being
   * silently dropped into the first cell.
   */
  app.get("/board/:id", async (req, reply) => {
    /**
     * The heading a block belongs under.
     *
     * Read off the raw properties rather than the canonical object: grouping
     * can name any field on any type, and the canonical form deliberately keeps
     * only the ones every surface needs. A select's stored value is not what a
     * reader should see, so the field's own label for it is used — the same
     * `optionLabel` rule the app follows.
     */
    const groupLabelFor = (rawJson: string, groupBy: string | null): string | null => {
      if (!groupBy) return null;
      const b = JSON.parse(rawJson) as { blockTypeId: string | null; properties: Record<string, unknown> };
      const type = b.blockTypeId ? types().get(b.blockTypeId) : undefined;
      if (groupBy === "type") return type?.name ?? "Untyped";
      if (!groupBy.startsWith("prop:")) return null;
      const key = groupBy.slice(5).split(".")[0]!;
      const value = b.properties?.[key];
      if (value === null || value === undefined || value === "") return null;
      const field = (type?.propertySchema?.fields ?? []).find((f) => f.key === key);
      if (field && typeof value === "string") return optionLabel(field, value);
      return String(value);
    };

    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const raw = mirror.rawBlock(id);
    if (!raw) return reply.code(404).send({ error: "no such collection in the mirror" });
    const row = JSON.parse(raw) as { properties: Record<string, unknown>; collectionKind: string | null };
    if (!row.collectionKind) {
      return reply.code(400).send({ error: "that block isn't a collection" });
    }
    // A kanban is a matrix with different chrome — same regions, same
    // placement — so the two share a renderer. Everything else is a sequence,
    // and gets shown as one rather than being given a bespoke half-imitation of
    // the web app's view.
    const gridded = row.collectionKind === "matrix" || row.collectionKind === "kanban";
    // A canvas places its members at coordinates rather than in an order, and
    // carries loose notes and connections of its own on the collection block.
    const isCanvas = row.collectionKind === "canvas";
    // A rollup owns no memberships at all — it is a nesting view over blocks
    // that live elsewhere, so looking for members finds nothing and it appeared
    // empty. It has to be resolved rather than read.
    const isRollup = row.collectionKind === "rollup";
    const props = row.properties ?? {};
    const cols = gridded ? Math.min(6, Math.max(1, Number(props.matrix_cols) || 2)) : 1;
    const rows = gridded ? Math.min(6, Math.max(1, Number(props.matrix_rows) || 2)) : 0;
    const defs = Array.isArray(props.matrix_regions) ? (props.matrix_regions as Record<string, unknown>[]) : [];
    const regions = Array.from({ length: cols * rows }, (_, i) => ({
      index: i,
      title: String(defs[i]?.title ?? "") || `Region ${i + 1}`,
      color: (defs[i]?.color as string | null) ?? null,
    }));

    // A smart matrix drops members its query no longer matches — a task that
    // has been completed, a date that has fallen out of range — and offers the
    // matches nobody has placed yet as a drawer to drag from. Both come from
    // the cached answer to the collection's own query.
    const grouping = groupByOf(props, row.collectionKind);
    const cachedQuery = mirror.get(`query.${id}`);
    const matching = cachedQuery ? new Set(JSON.parse(cachedQuery) as string[]) : null;
    const isSmart = Boolean(props.filter_query) && matching !== null;

    const idx = types();
    const placed = new Set<string>();
    const unplaced: unknown[] = [];
    const cells: Record<string, unknown[]> = {};
    for (const r of regions) cells[String(r.index)] = [];
    for (const m of mirror.membersOf(id)) {
      const block = JSON.parse(m.raw);
      const c = toCanonical(block, block.blockTypeId ? idx.get(block.blockTypeId) : undefined, {
        appOrigin: config.origin,
      });
      if (c.archivedAt) continue;
      if (isSmart && !matching!.has(c.id)) continue;
      placed.add(c.id);
      const ctx = JSON.parse(m.context) as { region?: unknown };
      // Explicitly, because Number(null) is 0 — so a card put back in the
      // drawer would silently reappear in the first region, which is exactly
      // what it did.
      const rv = ctx?.region;
      const region = rv === null || rv === undefined || rv === "" ? Number.NaN : Number(rv);
      const card = {
        group: groupLabelFor(m.raw, grouping),
        id: c.id, title: c.title, kind: c.kind, typeName: c.typeName,
        done: c.completion?.done ?? false, status: c.completion?.status ?? null,
        // A checkbox only belongs on something that can be completed — which is
        // a question about the type, not about whether a value happens to be
        // set. A note or a person has no status; a brand-new task has one it
        // hasn't used yet.
        completable: c.completable,
        due: c.schedule?.end?.value ?? null, tags: c.tags, url: c.url,
        // Only meaningful on a canvas; null everywhere else. Size comes with
        // position: a canvas node is a box someone sized on purpose, and
        // drawing them all alike loses the shape of the thing.
        x: num((ctx as Record<string, unknown>).x),
        y: num((ctx as Record<string, unknown>).y),
        w: num((ctx as Record<string, unknown>).w),
        h: num((ctx as Record<string, unknown>).h),
      };
      // A member with no region and a query match nobody has placed are the
      // same thing to look at — in this collection, not on the board — so they
      // share one list rather than being two states with one of them invisible.
      if (Number.isInteger(region) && region >= 0 && region < regions.length) {
        cells[String(region)]!.push(card);
      } else {
        unplaced.push(card);
      }
    }

    // The drawer: members sitting outside the grid, plus matches never placed.
    const drawer: unknown[] = [...unplaced];
    if (matching) {
      for (const mid of matching) {
        if (placed.has(mid)) continue;
        const r = mirror.rawBlock(mid);
        if (!r) continue;
        const b = JSON.parse(r);
        const c = toCanonical(b, b.blockTypeId ? idx.get(b.blockTypeId) : undefined, {
          appOrigin: config.origin,
        });
        if (c.archivedAt) continue;
        drawer.push({
          id: c.id, title: c.title, kind: c.kind, typeName: c.typeName,
          done: c.completion?.done ?? false, completable: c.completable,
          due: c.schedule?.end?.value ?? null,
          tags: c.tags, url: c.url, x: null, y: null, w: null, h: null,
          group: groupLabelFor(r, grouping),
        });
      }
    }

    // Stickies and connections live on the collection, not on any block, so
    // they have no ids of their own worth addressing — they are drawn and
    // nothing more, which is all a read-only view of a canvas needs.
    const notes = isCanvas && Array.isArray(props.canvas_notes)
      ? (props.canvas_notes as Record<string, unknown>[]).map((n) => ({
          // The id matters: connections are mostly between notes, not blocks,
          // so an edge with nothing to resolve its ends against draws nothing.
          id: String(n.id ?? ""),
          text: String(n.text ?? ""),
          x: num(n.x) ?? 0,
          y: num(n.y) ?? 0,
          w: num(n.w) ?? 200,
          h: num(n.h) ?? 120,
          color: typeof n.color === "string" ? n.color : null,
        }))
      : [];
    const edges = isCanvas && Array.isArray(props.canvas_edges)
      ? (props.canvas_edges as Record<string, unknown>[])
          .map((e) => ({
            from: String(e.from ?? ""),
            to: String(e.to ?? ""),
            // Everything the drawing needs: which edge of each box it leaves
            // and arrives at, how the line is styled, and which ends carry an
            // arrow. Losing any of it turns a diagram someone drew into a
            // handful of anonymous lines.
            fromSide: typeof e.fromSide === "string" ? e.fromSide : "e",
            toSide: typeof e.toSide === "string" ? e.toSide : "w",
            dash: typeof e.dash === "string" ? e.dash : "solid",
            arrow: typeof e.arrow === "string" ? e.arrow : "none",
            width: num(e.width) ?? 1.5,
            color: typeof e.color === "string" ? e.color : null,
            label: typeof e.label === "string" ? e.label : null,
          }))
          .filter((e) => e.from && e.to)
      : [];

    // A rollup: each root is a heading, and each level says how to find what
    // belongs under it — blocks of a type pointing at the parent through a
    // reference field, and optionally a collection's own members.
    const groups: unknown[] = [];
    if (isRollup) {
      const cfg = (props.rollup ?? {}) as { roots?: unknown; levels?: unknown };
      const roots = Array.isArray(cfg.roots) ? (cfg.roots as string[]) : [];
      const levels = Array.isArray(cfg.levels) ? (cfg.levels as Record<string, unknown>[]) : [];
      const all = canon(mirror.search({ limit: 500 }));
      const byId = new Map(all.map((b) => [b.id, b]));

      /** A collection's contents: its query's answer if it has one, else rows. */
      const membersOfCollection = (cid: string): string[] => {
        const cached = mirror.get(`query.${cid}`);
        if (cached) return JSON.parse(cached) as string[];
        return mirror.membersOf(cid).map((m) => (JSON.parse(m.raw) as { id: string }).id);
      };

      /**
       * What sits under a parent at a given depth, and under that, and so on.
       *
       * One level was enough for a two-tier rollup and wrong for anything
       * deeper — "projects, then tasks, then subtasks" showed two of its three
       * tiers and gave no sign the third existed.
       *
       * `seen` is the path walked to get here, not a global visited set: the
       * same block legitimately appears under two different parents, and
       * forbidding that would hide real rows. What it forbids is a block
       * turning up beneath itself, which a reference field pointing at an
       * ancestor would otherwise turn into an unbounded descent.
       */
      const nodeFor = (
        block: (typeof all)[number],
        depth: number,
        seen: ReadonlySet<string>,
      ): Record<string, unknown> => {
        const level = levels[depth];
        let children: Record<string, unknown>[] = [];
        if (level && !seen.has(block.id)) {
          const wantType = typeof level.typeId === "string" ? level.typeId : null;
          const refKey = typeof level.refKey === "string" ? level.refKey : null;
          const found = all.filter((b) => {
            if (b.collectionKind || b.archivedAt) return false;
            if (wantType && b.typeId !== wantType) return false;
            return b.links.some((l) => l.id === block.id && (!refKey || l.role === refKey));
          });
          if (level.members && block.collectionKind) {
            for (const bid of membersOfCollection(block.id)) {
              const b = byId.get(bid);
              if (b && !found.includes(b)) found.push(b);
            }
          }
          const nextSeen = new Set(seen).add(block.id);
          children = found.map((child) => nodeFor(child, depth + 1, nextSeen));
        }
        return {
          id: block.id,
          title: block.title,
          typeName: block.typeName,
          url: block.url,
          done: block.completion?.done ?? false,
          completable: block.completable,
          due: block.schedule?.end?.value ?? null,
          tags: block.tags,
          // Only the top tier is grouped, which is what the setting means:
          // it arranges the headings, not what hangs beneath each one.
          group: depth === 0 ? groupLabelFor(mirror.rawBlock(block.id) ?? "{}", grouping) : null,
          children,
        };
      };

      for (const rootId of roots) {
        const rootBlock = byId.get(rootId);
        if (!rootBlock) continue;
        // A collection root contributes each of its members as a heading; a
        // plain block is a heading on its own.
        //
        // "Members" has to mean the same thing it means everywhere else: for a
        // smart collection that is the query's answer, not the membership rows,
        // of which it has none. Reading only memberships is why a rollup rooted
        // on a smart list came back empty.
        const buckets = rootBlock.collectionKind
          ? membersOfCollection(rootId)
              .map((bid) => byId.get(bid))
              .filter((b): b is (typeof all)[number] => Boolean(b))
          : [rootBlock];
        for (const bucket of buckets) groups.push(nodeFor(bucket, 0, new Set()));
      }
    }

    const me = canon([raw])[0]!;
    // A sequence collection puts everything in one list; there are no regions to
    // put anything in, so what would have been "unplaced" is simply the contents.
    const members = gridded ? [] : drawer.slice();
    return envelope({
      id,
      title: me.title,
      kind: row.collectionKind,
      gridded,
      cols,
      rows,
      regions: gridded ? regions : [],
      cells: gridded ? cells : {},
      drawer: gridded ? drawer : [],
      members,
      canvas: isCanvas,
      rollup: isRollup,
      groups,
      // What the grouping is called, so a view can say what it is grouping by
      // rather than presenting unexplained headings.
      groupBy: grouping,
      notes,
      edges,
      smart: isSmart,
    });
  });

  /**
   * A turn with the assistant.
   *
   * The one thing here that cannot be answered from the mirror: the model lives
   * on the server. So this says so plainly when it can't be reached, rather
   * than spinning — every other surface in this app works offline and this one
   * doesn't, which is worth being loud about rather than quietly inconsistent.
   */
  app.post("/assistant", async (req, reply) => {
    const { message } = z.object({ message: z.string().min(1).max(20_000) }).parse(req.body);
    try {
      const turn = await hermes.assistant(message);
      return { ok: true, ...turn };
    } catch (err) {
      if (err instanceof OfflineError) {
        return reply.code(503).send({
          ok: false,
          error: "Hermes isn't reachable, and the assistant runs there — this is the one thing that needs the network.",
        });
      }
      return reply.code(502).send({ ok: false, error: (err as Error).message });
    }
  });

  app.post("/assistant/confirm", async (req, reply) => {
    const { calls } = z
      .object({ calls: z.array(z.object({ tool: z.string(), args: z.unknown() })).min(1).max(25) })
      .parse(req.body);
    try {
      const done = await hermes.assistantConfirm(calls);
      // What it just did may well have changed the mirror.
      void sync.catchUp();
      return { ok: true, ...done };
    } catch (err) {
      return reply.code(502).send({ ok: false, error: (err as Error).message });
    }
  });

  /**
   * What's coming up: dated blocks and calendar-feed events, day by day.
   *
   * An agenda rather than a month grid. The web app's calendar is the most
   * elaborate view it has — feeds, type pills, multi-day spans, an all-day
   * band, four range modes — and most of that exists because it has a full
   * screen to spend. In a panel this size the useful question is "what is
   * coming", so that is what this answers, while keeping the two things that
   * change what you see: which feeds an event came from, and which types show.
   *
   * Feed events are cached. They are the one part that must be fetched, and a
   * yesterday's copy of the calendar beats an empty one.
   */
  app.get("/agenda", async (req) => {
    const { days, date } = z
      .object({
        days: z.coerce.number().int().min(1).max(60).optional(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .parse(req.query);
    const span = days ?? 14;
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    // Parsed as noon so a timezone offset can't tip the date to its neighbour,
    // which is the classic way a day view ends up showing yesterday.
    const today = date ? new Date(`${date}T12:00:00`) : new Date();
    const start = iso(today);
    const endDate = new Date(today);
    endDate.setDate(endDate.getDate() + span - 1);
    const end = iso(endDate);

    let feed: unknown[] = [];
    let feedStale = false;
    try {
      const got = await hermes.feedEvents(start, end);
      feed = got.events;
      feedStale = got.stale;
      mirror.set(`feed.${start}.${end}`, JSON.stringify(feed));
    } catch {
      const cached = mirror.get(`feed.${start}.${end}`);
      if (cached) {
        feed = JSON.parse(cached) as unknown[];
        // Served from the last copy, which is worth saying: an agenda missing
        // half its meetings should not look like a quiet afternoon.
        feedStale = true;
      }
    }

    const idx = types();
    const blocks = canon(mirror.search({ limit: 500 })).filter((b) => !b.archivedAt && !b.collectionKind);
    const typeNames = new Set<string>();
    const feedsSeen = new Map<string, { id: string; name: string; color: string }>();

    /** The feed a block was converted from, if it was. */
    const feedOriginOf = (blockId: string): string | null => {
      const raw = mirror.rawBlock(blockId);
      if (!raw) return null;
      const props = (JSON.parse(raw) as { properties?: Record<string, unknown> }).properties ?? {};
      const origin = props.feed_origin;
      return typeof origin === "string" && origin ? origin : null;
    };

    const dayOf = (v: string | null | undefined) => (v ? v.split("T")[0] ?? null : null);
    const buckets = new Map<string, { items: unknown[]; events: unknown[] }>();
    for (let i = 0; i < span; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      buckets.set(iso(d), { items: [], events: [] });
    }

    for (const b of blocks) {
      const s = dayOf(b.schedule?.start?.value);
      const e = dayOf(b.schedule?.end?.value);
      if (!s && !e) continue;
      typeNames.add(b.typeName);
      // A span belongs to every day it covers, the way the web app treats one:
      // a task available Monday and due Friday is Wednesday's business too.
      for (const [date, bucket] of buckets) {
        const on = s && e ? date >= s && date <= e : date === (s ?? e);
        if (!on) continue;
        bucket.items.push({
          id: b.id, title: b.title, kind: b.kind, typeName: b.typeName,
          done: b.completion?.done ?? false,
          completable: b.completable,
          at: b.schedule?.start?.allDay === false ? b.schedule?.start?.value ?? null : null,
          // The field's own name for its far end, not the word "due". A task's
          // datespan ends on a due date; an event's simply stops, and calling
          // that "due" says something about it that isn't true.
          endLabel: e === date ? b.schedule?.endLabel ?? null : null,
          // A block converted from a calendar feed remembers which one, so it
          // can wear that calendar's colour — and go quiet when that feed is
          // switched off, the same as the events still living in it.
          feedOrigin: feedOriginOf(b.id),
          url: b.url, tags: b.tags,
        });
      }
    }

    for (const raw of feed as Record<string, unknown>[]) {
      const date = dayOf(String(raw.start ?? ""));
      const bucket = date ? buckets.get(date) : undefined;
      if (!bucket) continue;
      const feedId = String(raw.feedId ?? "");
      const feedName = String(raw.feedName ?? "");
      const color = String(raw.color ?? "");
      if (feedId) feedsSeen.set(feedId, { id: feedId, name: feedName, color });
      bucket.events.push({
        uid: String(raw.uid ?? ""),
        summary: String(raw.summary ?? ""),
        location: String(raw.location ?? ""),
        start: String(raw.start ?? ""),
        allDay: Boolean(raw.allDay),
        feedId,
        feedName,
        color,
      });
    }

    return envelope({
      start,
      end,
      // Events are never offered as a togglable type: the web app doesn't offer
      // it either, and a calendar you can switch the calendar off in is a
      // strange object. Feeds are switchable individually instead.
      types: [...typeNames].filter((t) => t.toLowerCase() !== "event").sort(),
      feeds: [...feedsSeen.values()].sort((a, b) => a.name.localeCompare(b.name)),
      feedStale,
      days: [...buckets].map(([date, b]) => ({ date, items: b.items, events: b.events })),
    });
  });

  app.get("/types", async () => envelope([...types().values()].map((t) => ({ id: t.id, name: t.name }))));

  app.post("/sync", async (req) => {
    const { full } = z.object({ full: z.coerce.boolean().optional() }).parse(req.query);
    const r = full ? await sync.full() : await sync.catchUp();
    const drained = r.state === "ok" ? await queue.drain() : [];
    return { sync: r, queue: drained };
  });

  app.get("/queue", async () =>
    queue.list().map(({ row, intent }) => ({
      id: row.id,
      kind: row.kind,
      intent,
      createdAt: row.createdAt,
      parkedReason: row.parkedReason,
      attempts: row.attempts,
    })),
  );

  app.post("/queue/:id/retry", async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    mirror.unpark(id);
    return { retried: id, result: await queue.drain() };
  });

  app.delete("/queue/:id", async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    mirror.dequeue(id);
    return { dropped: id };
  });

  /**
   * Turn a lump of selected text into a task.
   *
   * The split is the same one Hermes itself makes when you extract a selection
   * into a new block: the first line is the title, the rest goes in the type's
   * prose field, and if the type has nowhere to put prose then everything goes
   * in the title rather than being dropped. Caller sends text; where the pieces
   * land is worked out here, because here is where the property schema is.
   */
  app.post("/capture", async (req, reply) => {
    const body = z
      .object({
        text: z.string().min(1),
        as: z.enum(["task", "note"]).default("task"),
        blockTypeId: z.string().uuid().optional(),
      })
      .parse(req.body);

    const typeId = body.blockTypeId ?? defaultTypeId(body.as);
    if (!typeId) {
      return reply.code(503).send({ error: "no block types mirrored yet — has a sync finished?" });
    }
    const type = types().get(typeId);
    const text = body.text.replace(/\r\n/g, "\n").trim();

    // A note is a text block: its body *is* its content and it has no title to
    // split off, so the selection goes across whole.
    if (body.as === "note" || type?.isText) {
      const res = await app.inject({
        method: "POST",
        url: "/write",
        payload: { kind: "create", blockTypeId: typeId, content: text },
      });
      const firstLine = (text.split("\n").find((l) => l.trim()) ?? "").trim();
      return reply.code(res.statusCode).send({
        ...(res.json() as Record<string, unknown>),
        title: firstLine.slice(0, 120) || "Untitled",
        storedProse: true,
      });
    }

    const lines = text.split("\n");
    const firstIndex = lines.findIndex((l) => l.trim());
    const title = (firstIndex >= 0 ? lines[firstIndex]! : "").trim().slice(0, 500) || "Untitled";
    const rest = firstIndex >= 0 ? lines.slice(firstIndex + 1).join("\n").trim() : "";

    const prose = bodyFieldKey(type?.propertySchema ?? null);
    const properties: Record<string, unknown> =
      rest && prose
        ? { title, [prose]: rest }
        : rest
          ? // Nowhere for prose to go. Keeping it in the title is ugly and is
            // still better than a capture that silently ate most of what was
            // selected.
            { title: `${title}\n${rest}`.slice(0, 2000) }
          : { title };

    const res = await app.inject({
      method: "POST",
      url: "/write",
      payload: { kind: "create", blockTypeId: typeId, properties },
    });
    return reply.code(res.statusCode).send({
      ...(res.json() as Record<string, unknown>),
      title,
      storedProse: Boolean(rest && prose),
    });
  });

  /**
   * Writes go straight out when Hermes is there, and queue when it isn't.
   *
   * A create is written into the mirror either way and keeps the same id
   * whichever path it took, so a task added on a plane is findable, openable and
   * linkable before it has ever reached a server.
   */
  app.post("/write", async (req, reply) => {
    const body = z
      .discriminatedUnion("kind", [
        z.object({
          kind: z.literal("create"),
          blockTypeId: z.string().uuid().optional(),
          content: z.string().optional(),
          properties: z.record(z.unknown()).optional(),
        }),
        z.object({ kind: z.literal("complete"), blockId: z.string().uuid(), status: z.string().optional() }),
        z.object({ kind: z.literal("append"), date: z.string(), text: z.string().min(1) }),
        z.object({
          kind: z.literal("move"),
          collectionId: z.string().uuid(),
          blockId: z.string().uuid(),
          // null means "put it back in the drawer": still a member of the
          // collection, just not placed anywhere in the grid.
          region: z.number().int().min(0).max(35).nullable(),
        }),
      ])
      .parse(req.body);

    let intent: Intent;
    let baseVersion: number | null = null;

    if (body.kind === "create") {
      const typeId = body.blockTypeId ?? defaultTypeId(body.content !== undefined ? "note" : "task");
      if (!typeId) {
        return reply.code(503).send({
          error: "no block types mirrored yet — the first sync hasn't happened, so there's nothing to create this as",
        });
      }
      intent = {
        kind: "create",
        id: randomUUID(),
        blockTypeId: typeId,
        content: body.content,
        properties: body.properties,
      };
    } else if (body.kind === "complete") {
      const raw = mirror.rawBlock(body.blockId);
      if (!raw) return reply.code(404).send({ error: "not in the mirror" });
      const row = JSON.parse(raw) as { version: number; blockTypeId: string | null };
      const schema = row.blockTypeId ? types().get(row.blockTypeId)?.propertySchema : null;
      const status = body.status ?? schema?.complete_values?.[0];
      if (!status) return reply.code(400).send({ error: "that block's type has no completed status" });
      baseVersion = row.version;
      intent = { kind: "complete", blockId: body.blockId, status };
    } else if (body.kind === "move") {
      // Asked before the local placement below, which would otherwise make
      // every card look like an existing member.
      const join = !mirror.isMember(body.collectionId, body.blockId);
      intent = {
        kind: "move",
        collectionId: body.collectionId,
        blockId: body.blockId,
        region: body.region,
        join,
      };
      // Show the card in its new cell straight away. The sync loop will confirm
      // it, and a drag that snapped back while the request was in flight would
      // read as the drag having failed.
      mirror.placeLocally(body.collectionId, body.blockId, body.region);
    } else {
      intent = { kind: "append", date: body.date, text: body.text };
    }

    try {
      const applied = await applyNow(intent);
      // Put it in the mirror before answering. The sync loop would collect it
      // within the poll interval anyway, but a write that isn't findable the
      // instant it succeeds reads as a write that didn't happen.
      if (typeof applied.id === "string") await sync.refresh([applied.id]);
      return { applied: true, ...applied };
    } catch (err) {
      if (!(err instanceof OfflineError)) {
        if (err instanceof HermesError) return reply.code(err.status).send({ error: err.message });
        throw err;
      }
      const id = queue.add(intent, baseVersion);
      if (intent.kind === "create") stashLocalCreate(intent.id, intent);
      return reply.code(202).send({
        applied: false,
        queued: id,
        ...(intent.kind === "create" ? { id: intent.id } : {}),
        note: "Hermes is not reachable; this is queued and will go out on reconnect.",
      });
    }
  });

  /** Try the write against Hermes right now; throws OfflineError if it can't. */
  async function applyNow(intent: Intent): Promise<Record<string, unknown>> {
    if (intent.kind === "create") {
      const row = await hermes.createBlock({
        id: intent.id,
        blockTypeId: intent.blockTypeId,
        content: intent.content,
        properties: intent.properties,
      });
      return { id: row.id };
    }
    if (intent.kind === "move") {
      // An explicit null, not an empty object: Hermes merges context rather
      // than replacing it, so `{}` leaves the old region where it was.
      await hermes.placeMember(
        intent.collectionId,
        intent.blockId,
        { region: intent.region },
        intent.join,
      );
      return { id: intent.blockId };
    }
    if (intent.kind === "complete") {
      const page = await hermes.blocksByIds([intent.blockId]);
      const current = page.blocks[0];
      if (!current) throw new HermesError(404, "block not found");
      const schema = types().get(current.blockTypeId ?? "")?.propertySchema;
      if (!schema?.status_field) throw new HermesError(400, "no status field on that type");
      await hermes.patchBlock(intent.blockId, {
        version: current.version,
        properties: { ...current.properties, [schema.status_field]: intent.status },
      });
      return { id: intent.blockId };
    }
    const note = await hermes.dailyNote(intent.date);
    const { appendedContent } = await import("./queue.js");
    await hermes.patchBlock(note.id, {
      version: note.version,
      content: appendedContent(note.content, intent.text),
    });
    return { id: note.id, date: intent.date };
  }

  /**
   * A block created offline exists locally straight away, carrying the id it
   * will keep. Without this it would be invisible until the network came back —
   * which is exactly the moment the user least wants to be told to wait.
   */
  function stashLocalCreate(id: string, intent: Intent & { kind: "create" }): void {
    const now = new Date().toISOString();
    const idx = types();
    const row = {
      id,
      blockTypeId: intent.blockTypeId ?? null,
      collectionKind: null,
      content: intent.content ?? null,
      properties: intent.properties ?? {},
      version: 0, // not yet a server version; nothing may patch on this
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
      tags: [] as string[],
    };
    const c = toCanonical(row, intent.blockTypeId ? idx.get(intent.blockTypeId) : undefined, {
      appOrigin: config.origin,
    });
    mirror.putBlocks([
      {
        id,
        raw: JSON.stringify(row),
        updatedAt: now,
        archived: false,
        title: c.title,
        body: c.body ?? "",
        kind: c.kind,
        typeId: row.blockTypeId,
        noteDate: c.noteDate,
      },
    ]);
  }

  app.addHook("onClose", async () => {
    if (existsSync(deps.socketPath)) unlinkSync(deps.socketPath);
  });

  return app;
}

/**
 * A Unix socket path is a fixed-size field in a struct, not a string: 104 bytes
 * on macOS, and the kernel simply won't bind a longer one.
 */
const SUN_PATH_MAX = 103;

/** Bind the socket, replacing one left behind by a process that didn't exit cleanly. */
export async function listen(app: FastifyInstance, socketPath: string): Promise<void> {
  const bytes = Buffer.byteLength(socketPath);
  if (bytes > SUN_PATH_MAX) {
    throw new Error(
      `Socket path is ${bytes} bytes; the limit is ${SUN_PATH_MAX}.\n  ${socketPath}\n` +
        `Set TALARIA_SOCKET to something shorter.`,
    );
  }
  if (existsSync(socketPath)) unlinkSync(socketPath);
  await app.listen({ path: socketPath });
  // listen() can resolve without the socket existing — an over-long path is the
  // way that happens — and a daemon announcing that it is serving when nothing
  // is bound is the exact failure this whole project is trying not to have.
  if (!existsSync(socketPath)) {
    throw new Error(`listen() returned but no socket exists at ${socketPath}`);
  }
  // The socket is the only thing standing between this and anything else on the
  // machine that fancies a look at the mirror.
  chmodSync(socketPath, 0o600);
}
