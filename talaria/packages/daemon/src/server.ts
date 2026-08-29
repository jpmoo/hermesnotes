import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import {
  fieldFor,
  regionLabel,
  regionName,
  type Region,
  isComplete,
  optionLabel,
  read,
  toCanonical,
  type InterchangeObject,
  type InterchangeType,
} from "@talaria/canonical";
import type { Config } from "./config.js";
import { ContextRecord, FrontmostWatcher, frontmostApp, LAUNCHERS, stripMarkers, TITLE_BLIND, WINDOW_HOURS } from "./context.js";
import { focusedText, Glance, MAX_SOURCE, mayEmbedTitle, ollamaEmbedder } from "./glance.js";
import { HermesError, OfflineError, type Hermes } from "./hermes.js";
import { regionNameAt, type Interchange } from "./interchange.js";
import type { Mirror } from "./mirror.js";
import { applyRegionActions, Queue, type Intent } from "./queue.js";
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
/** A sort or grouping key, as the format names one. */
export type By = { field?: string; part?: string; meta?: string };
export type Order = { sort?: { by?: By; direction?: string }[]; groupBy?: By };

/**
 * A format sort key in the spelling the rest of this file already speaks.
 *
 * `"type"` and `"prop:<key>[.part]"` are what `groupLabelFor` and `valueUnder`
 * read, and they were the producer's spelling because the producer's private
 * view state was the only place this lived. It is on the collection now, so the
 * translation happens once, here, and the two readers are unchanged.
 */
function keyOf(by: By | undefined): string | null {
  if (!by) return null;
  if (by.meta) return by.meta === "updated" ? "edited" : by.meta;
  if (typeof by.field !== "string" || !by.field) return null;
  return `prop:${by.field}${by.part ? `.${by.part}` : ""}`;
}

/**
 * How a collection was told to arrange itself.
 *
 * This used to reach into `view_state` and `rollup_views.top` — the producer's
 * own saved view, under a prefix this seam strips — because sorting and
 * grouping were things the format could not say. They are `collection.order`
 * now, so the read is the format's and works against any producer.
 */
function orderOf(row: { order?: Order }): Order {
  return row.order ?? {};
}

/** A number, or null — canvas geometry arrives as numbers or not at all. */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function buildServer(deps: {
  config: Config;
  mirror: Mirror;
  hermes: Hermes;
  ix: Interchange;
  sync: Sync;
  socketPath: string;
}): FastifyInstance {
  const { config, mirror, hermes, ix, sync } = deps;
  const queue = new Queue(ix, hermes, mirror);
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
    // Declared beats named. A type that says it is a note is the one to capture
    // into, whatever its owner calls it.
    const all = [...types().values()];
    const declaring = (p: string) => all.find((t) => t.profiles?.[p])?.id;
    if (want === "note") return declaring("note") ?? all.find((t) => t.name?.toLowerCase() === "text")?.id;
    return declaring("task") ?? all.find((t) => t.name?.toLowerCase() === "task")?.id;
  };

  const types = (): Map<string, InterchangeType> => {
    const m = new Map<string, InterchangeType>();
    for (const raw of mirror.types()) {
      const t = JSON.parse(raw) as InterchangeType;
      m.set(t.id, t);
    }
    return m;
  };

  /** Every answer says how much it can be trusted. Nothing serves silently stale. */
  const envelope = <T>(data: T, extra: Record<string, unknown> = {}) => {
    const f = freshnessOf(sync.lastSuccessAt, sync.everSynced);
    return {
      data,
      freshness: f,
      syncedAt: sync.lastSuccessAt,
      note: describe(f, sync.lastSuccessAt),
      ...extra,
    };
  };

  const canon = (raws: string[]) => {
    const idx = types();
    return raws.map((raw) => {
      const row = JSON.parse(raw);
      return toCanonical(row, row.type ? idx.get(row.type) : undefined, {
        appOrigin: config.origin,
        collectionKind: row.collectionKind ?? null,
      });
    });
  };

  /**
   * What the machine was doing, lately.
   *
   * Local to this daemon and to this machine. Never synced, never exported,
   * never part of an interchange envelope — see `context.ts` for why that is a
   * rule rather than an omission.
   */
  /**
   * The accessibility reader, beside the app that ships it.
   *
   * Resolved from the daemon's own location rather than a PATH lookup: this is
   * a private helper of one bundle, not a tool anybody installs, and finding a
   * different `talaria-ax` on the PATH would be a worse outcome than finding
   * none. Missing is fine — Glance falls back to the window title.
   */
  const AX_HELPER = join(dirname(fileURLToPath(import.meta.url)), "Talaria.app/Contents/MacOS/talaria-ax");

  const context = new ContextRecord(mirror, config.contextExclude);

  /**
   * Glance keeps its own index, deliberately.
   *
   * The producer's vectors are made by a model on the producer's network, which
   * a laptop away from home cannot reach — and away from home is exactly when a
   * memory aid earns its place. Local model, local index, local comparison.
   */
  const glance = new Glance(mirror, ollamaEmbedder(config.glanceUrl, config.glanceModel));
  const forgotten = glance.reconcileModel();
  // Kept up to date in the background, a slice at a time. Deliberately not on
  // the sync path: a library is a few hundred model calls on first run, and
  // making a sync wait for them would turn a thirty-second poll into a stall.
  // A Glance one block behind is not wrong, it is behind.
  const indexer = setInterval(() => {
    void glance.index(25).catch(() => {});
  }, 20_000);
  indexer.unref();
  if (forgotten) console.error(`[talaria] glance: model changed — forgot ${forgotten} vector(s)`);

  /**
   * Nothing on this machine emits a focus event, so the daemon watches.
   *
   * Measured, not assumed: a window manager's events describe windows and
   * workspaces, and ⌘-Tab between two applications produces none of them.
   */
  const frontmost = new FrontmostWatcher(context, 2000, config.aerospaceCli);
  frontmost.start();
  app.addHook("onClose", async () => frontmost.stop());

  /**
   * Record a moment. Called by whatever is watching the desktop.
   *
   * The window manager's part is the workspace and only the workspace — it is
   * the one thing here that knows about them, and the one thing it can tell us
   * that the poll cannot see:
   *
   *   aerospace list-windows --focused \
   *     --format '%{app-bundle-id}\t%{workspace}\t%{window-title}'
   *
   * Answers with what was actually stored rather than an acknowledgement, so a
   * caller can see the redaction instead of trusting it.
   */
  app.post("/context", async (req, reply) => {
    const body = z
      .object({
        app: z.string().nullish(),
        title: z.string().nullish(),
        workspace: z.string().nullish(),
        block: z.string().nullish(),
      })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "bad context" });
    // Held so the next poll carries it. The two halves of a row arrive from
    // different places at different times, and a poll two seconds after a
    // workspace switch must not write "workspace unknown" over the answer.
    context.rememberWorkspace(body.data.workspace ?? null);
    // A workspace change on its own is not a moment worth a row. The window
    // manager knows the
    // workspace and nothing else — no app, no title — so writing one produced a
    // row saying "?", which is noise in the audit and can never be the answer to
    // `working()` anyway. The poll picks the new workspace up within two seconds
    // and attaches it to something that actually names an application.
    const onlyWorkspace =
      !body.data.app && !body.data.title && !body.data.block && Boolean(body.data.workspace);
    if (onlyWorkspace) return { recorded: false, why: "workspace noted; the next poll will carry it" };
    return context.note(body.data);
  });

  /**
   * Everything held, and the settings that govern it.
   *
   * The audit is one command on purpose. A record whose contents you cannot see
   * is one you cannot consent to, and "it only keeps a little" is a claim that
   * has to be checkable rather than believed.
   */
  app.get("/context", async (req) => {
    const q = z.object({ limit: z.coerce.number().int().optional() }).safeParse(req.query);
    return {
      recording: context.recording,
      windowHours: WINDOW_HOURS,
      excluded: config.contextExclude,
      working: context.working(),
      recent: context.recent(q.success ? (q.data.limit ?? 50) : 50),
    };
  });

  /** Off, and empty. Both halves, or it is not an off switch. */
  app.delete("/context", async () => {
    const forgotten = context.stop();
    return { recording: false, forgotten };
  });

  app.post("/context/on", async () => {
    context.start();
    return { recording: true };
  });

  /**
   * What the library knows about what you are looking at.
   *
   * With no `q`, the question is the front window's own title — which is why
   * this exists at all. The words are embedded on this machine and discarded;
   * only the vector is ever compared, and it never leaves either.
   *
   * Deliberately answers with canonical blocks rather than ids, because the
   * caller is a panel that has to draw them and a second round trip per hit
   * would make a hotkey feel like a page load.
   */
  app.get("/glance", async (req) => {
    const { q, k } = z
      .object({ q: z.string().optional(), k: z.coerce.number().int().min(1).max(40).optional() })
      .parse(req.query);

    // Asked live rather than read from the record, and this is the whole
    // difference between a feature and a message saying it has nothing to work
    // with. The record withholds titles for every app outside a short trusted
    // list, because a stored title lives eight hours; Glance keeps nothing, so
    // it reads the title, embeds it here, and drops it. On the first run the
    // front window was Claude Desktop — not on the list — and Glance had
    // nothing to ask about while sitting in front of the thing being asked
    // about.
    let asked = q?.trim() ?? "";
    let source: "asked" | "document" | "title" | null = q?.trim() ? "asked" : null;
    if (!asked) {
      const front = await frontmostApp();
      // The blind list first, and before anything is read rather than after.
      // A password manager's contents are not to be looked at, and "we looked
      // and then discarded it" is not the same promise as "we did not look".
      if (front && mayEmbedTitle(front.app, TITLE_BLIND)) {
        // The document, if it will show us. A title is a fallback rather than
        // the intent: "Untitled" is a real filename and tells nobody anything.
        const focused = await focusedText(AX_HELPER);
        const text = focused.text?.trim();
        if (text) {
          asked = text.slice(0, MAX_SOURCE);
          source = "document";
        } else {
          // The window's real title before Launch Services' idea of one.
          //
          // `frontmostApp` reports the application's *display name* — its
          // lsappinfo record's leading quoted token is the name field, not the
          // window's — so this branch spent a fortnight embedding the string
          // "Google Chrome" and wondering why a letter to Milton matched
          // nothing. The helper reads the window itself.
          const title = focused.title?.trim() || front.title;
          if (title) {
            asked = stripMarkers(title).slice(0, MAX_SOURCE);
            source = "title";
          }
        }
      }
    }
    if (!asked) {
      return envelope([], { question: null, note: "nothing in front worth asking about" });
    }

    try {
      const hits = await glance.similar(asked, k ?? 8);
      const idx = types();
      const results = hits.flatMap((h) => {
        const raw = mirror.rawBlock(h.id);
        if (!raw) return [];
        const row = JSON.parse(raw);
        const c = toCanonical(row, row.type ? idx.get(row.type) : undefined, {
          appOrigin: config.origin,
          collectionKind: row.collectionKind ?? null,
        });
        return [{ score: Number(h.score.toFixed(4)), block: c }];
      });
      return envelope(results, { question: asked, source });
    } catch (err) {
      // A model that is not running is an ordinary condition, not a failure of
      // the daemon — and saying which is the difference between "install
      // Ollama" and "something is broken".
      return envelope([], { question: asked, source, error: (err as Error).message });
    }
  });

  /** Fill the index now rather than waiting for the timer. */
  app.post("/glance/index", async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(2000).optional() }).parse(req.query);
    return glance.index(limit ?? 200);
  });

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
      // What the producer promised and its answers did not keep. Empty is the
      // normal case and the reason this is worth reporting at all: something
      // here means the far end is older than the manifest it is serving.
      mismatch: sync.mismatch,
      // Written by the app, because only the app can say. Absent means it has
      // not run since this was added rather than that it is denied — the two
      // are different and reporting them as one is how a diagnostic starts
      // lying.
      accessibility: (() => {
        try {
          const raw = readFileSync(`${process.env.HOME}/Library/Application Support/Talaria/accessibility.json`, "utf8");
          return JSON.parse(raw) as { granted: boolean; at: string };
        } catch {
          return null;
        }
      })(),
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

    const reach = await ix.reachable(sync.cursor);
    add("producer", reach.ok, reach.detail);

    const q = mirror.pending();
    const parked = q.filter((x) => x.parkedReason);
    add("queue", parked.length === 0, parked.length ? `${parked.length} parked, needs a decision` : `${q.length} waiting`);

    /**
     * Is anything still watching the desktop?
     *
     * The frontmost poll reads an undocumented tool and is written to degrade to
     * silence rather than throw, which is right — and means a change in that
     * tool's output stops the record dead with nothing said. That already
     * happened once: the parse expected `CFBundleIdentifier=` and the answer
     * said `bundleID=`, so every poll for a day returned nothing and the only
     * sign was an empty table nobody had reason to look at.
     *
     * So it is asked directly, every time, rather than inferred from rows.
     */
    if (!context.recording) {
      add("context", true, "recording is off");
    } else {
      const front = await frontmostApp();
      const rows = context.recent(1);
      const last = rows[0] ? new Date(rows[0].at) : null;
      const mins = last ? Math.round((Date.now() - last.getTime()) / 60000) : null;
      add(
        "context",
        Boolean(front),
        front
          ? `watching — ${front.app}` + (mins === null ? ", nothing recorded yet" : `, last row ${mins}m ago`)
          : "lsappinfo told us nothing — the frontmost poll is doing nothing at all",
      );

      /**
       * Is the workspace half alive?
       *
       * The poll cannot see workspaces; only the window manager can, and a
       * subscription is a foreground process that dies with the terminal that
       * started it. So the most likely state of this wiring is *stopped*, and
       * the symptom is rows that merely stop carrying a name — invisible unless
       * something asks.
       */
      const withWorkspace = context.recent(1).some((r) => r.workspace);
      add(
        "workspace",
        withWorkspace,
        withWorkspace
          ? "arriving from the window manager"
          : "the newest row names no workspace — is `aerospace` on the daemon's PATH? set `aerospaceCli` in config.json",
      );
    }

    return { ok: checks.every((c) => c.ok), checks };
  });

  /** Reads never touch the network — this is the whole point of the mirror. */
  app.get("/blocks", async (req) => {
    const q = z
      .object({
        q: z.string().optional(),
        kind: z.string().optional(),
        // For filling a reference field: "which Projects are there to pick
        // from" is a question about the type the user made, not about the
        // canonical kind it maps to.
        type: z.string().optional(),
        archived: z.coerce.boolean().optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      })
      .parse(req.query);
    return envelope(
      canon(
        mirror.search({
          q: q.q,
          kind: q.kind,
          typeId: q.type,
          includeArchived: q.archived,
          limit: q.limit,
        }),
      ),
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
    // `epoch` is the cursor, and is a string. The name predates the
    // interchange cursor and is kept because both ends agree on it; what is
    // worth knowing is that it is opaque — compared for equality by the
    // indexer, never parsed. Declaring it an integer on the Swift side is what
    // silently stopped Spotlight reindexing for a fortnight.
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
      const b = JSON.parse(rawJson) as { type?: string | null; properties: Record<string, unknown> };
      const type = b.type ? types().get(b.type) : undefined;
      if (groupBy === "type") return type?.name ?? "Untyped";
      if (!groupBy.startsWith("prop:")) return null;
      const key = groupBy.slice(5).split(".")[0]!;
      const value = b.properties?.[key];
      if (value === null || value === undefined || value === "") return null;
      const field = (type?.fields ?? []).find((f) => f.key === key) ?? null;
      if (field && typeof value === "string") return optionLabel(field, value);
      return String(value);
    };

    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const raw = mirror.rawBlock(id);
    if (!raw) return reply.code(404).send({ error: "no such collection in the mirror" });
    const row = JSON.parse(raw) as {
      properties: Record<string, unknown>;
      collectionKind: string | null;
      placement?: { regions?: Region[] };
      membership?: { mode?: string; query?: unknown };
      order?: Order;
    };
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
    // Region names and labels come from the collection's declared placement,
    // which is where the format keeps them. They used to be read off Hermes'
    // `matrix_regions`, which does not survive an export — so a real board
    // arrived with four regions called "Region 1" through "Region 4", matched
    // correctly against every card and rendered as nothing anybody had written.
    const declared = (row.placement?.regions ?? []) as Region[];
    const regions = Array.from({ length: cols * rows }, (_, i) => ({
      index: i,
      name: declared[i] ? regionName(declared[i]!) : `region-${i}`,
      title: declared[i] ? regionLabel(declared[i]!) : `Region ${i + 1}`,
      // Deliberately Hermes-specific, and the only such thing in this file.
      // The format does not name a colour and should not: a prefixed key is one
      // producer's word, so nothing generic can read it. Talaria chooses to know
      // this one so a Hermes board looks like itself — decoration only, and
      // nothing anywhere depends on it being there.
      color: (declared[i] as Record<string, unknown> | undefined)?.["hermes:color"] ?? null,
    }));

    // A smart matrix drops members its query no longer matches — a task that
    // has been completed, a date that has fallen out of range — and offers the
    // matches nobody has placed yet as a drawer to drag from. Both come from
    // the cached answer to the collection's own query.
    /**
     * A table's columns, as configured.
     *
     * The keys are the app's own: "title", "edited", "prop:<key>", and a
     * datespan split into "prop:<key>.start" and "prop:<key>.end" because the
     * two legs are separate columns. Rendered as a list of blocks with a date
     * underneath, a table stops being a table — the columns are the point.
     */
    const tableColumns = (): { key: string; label: string; width: number | null }[] => {
      const raw = Array.isArray(props.table_columns) ? (props.table_columns as string[]) : [];
      // Stored per column in pixels, and not for every column — a width the
      // user has never dragged simply isn't there. Passed on as-is; turning
      // them into shares of whatever room there is belongs where the room is
      // known, which is not here.
      const widths = (props.table_col_widths ?? {}) as Record<string, unknown>;
      const widthOf = (key: string): number | null =>
        typeof widths[key] === "number" && Number.isFinite(widths[key]) ? (widths[key] as number) : null;
      const typeOf = (typeId: string | null) => (typeId ? types().get(typeId) : undefined);
      // Members can be of mixed types; the first one with a schema names the
      // columns, which is what the app does when it draws a heading.
      const firstTyped = mirror.membersOf(id)
        .map((m) => JSON.parse(m.raw) as { type?: string | null })
        .find((b) => b.type);
      const schema = typeOf(firstTyped?.type ?? null);
      return raw.map((key) => {
        if (key === "title") return { key, label: "Title", width: widthOf(key) };
        if (key === "edited") return { key, label: "Edited", width: widthOf(key) };
        const bare = key.startsWith("prop:") ? key.slice(5) : key;
        const [fieldKey, leg] = bare.split(".");
        const field = (schema?.fields ?? []).find((f: { key: string }) => f.key === fieldKey);
        const base = field?.label?.trim() || (fieldKey ?? key).replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        if (leg === "start") return { key, label: field?.startLabel?.trim() || `${base} from`, width: widthOf(key) };
        if (leg === "end") return { key, label: field?.endLabel?.trim() || `${base} to`, width: widthOf(key) };
        return { key, label: base, width: widthOf(key) };
      });
    };

    /**
     * The dates on a card, the way the board shows them.
     *
     * Every dated field the type has, not just the one the canonical object
     * picked as "the" schedule — a task with an available date and a due date
     * has a range, and showing only its far end says less than the web app does
     * about the same card. Formatted short, because a chip is small.
     *
     * Overdue means the far end has passed and the thing can still be finished;
     * a note with yesterday's date on it is not late for anything.
     */
    const datesOf = (rawBlock: string): { text: string; overdue: boolean }[] => {
      const b = JSON.parse(rawBlock) as {
        type?: string | null;
        properties: Record<string, unknown>;
      };
      const type = b.type ? types().get(b.type) : undefined;
      if (!type) return [];
      const done = isComplete(type, b as InterchangeObject);
      const canBeLate = Boolean(type.profiles?.task?.status) && !done;
      const today = new Date().toISOString().slice(0, 10);
      const short = (v: string) => {
        const d = new Date(v.includes("T") ? v : `${v}T12:00:00`);
        return Number.isNaN(d.getTime())
          ? v
          : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      };
      const out: { text: string; overdue: boolean }[] = [];
      for (const f of type.fields ?? []) {
        const v = (b.properties ?? {})[f.key];
        if (v === null || v === undefined || v === "") continue;
        if (f.kind === "datetime" || f.kind === "date") {
          out.push({ text: short(String(v)), overdue: false });
        } else if (f.kind === "datespan" && typeof v === "object") {
          const span = v as { start?: string; end?: string };
          const a = span.start ? short(span.start) : "";
          const z = span.end ? short(span.end) : "";
          if (!a && !z) continue;
          const endDay = span.end ? String(span.end).slice(0, 10) : null;
          out.push({
            text: a && z ? `${a} – ${z}` : a || z,
            overdue: canBeLate && Boolean(endDay) && endDay! < today,
          });
        }
      }
      return out;
    };

    /** One cell, as text. */
    const cellValue = (rawBlock: string, key: string): string => {
      const b = JSON.parse(rawBlock) as {
        type?: string | null;
        properties: Record<string, unknown>;
        created?: string;
        updated?: string;
      };
      const schema = b.type ? types().get(b.type) : null;
      // `updated` and `created`, not `updatedAt`/`createdAt`. These rows are
      // interchange objects now, and this read was still spelling them the way
      // Hermes' own rows spelled them — so an "Edited" column threw on
      // undefined and took the whole board down with a 500, while a "Created"
      // one quietly drew every cell blank. The loud one and the silent one, from
      // the same wrong name.
      if (key === "edited") return String(b.updated ?? "").slice(0, 10);
      if (key === "created") return String(b.created ?? "").slice(0, 10);
      const bare = key.startsWith("prop:") ? key.slice(5) : key;
      const [fieldKey, leg] = bare.split(".");
      if (!fieldKey) return "";
      const value = b.properties?.[fieldKey];
      if (value === null || value === undefined || value === "") return "";
      if (leg) {
        const span = value as Record<string, unknown>;
        const v = span?.[leg];
        return typeof v === "string" ? v.replace("T", " ") : "";
      }
      const field = (schema?.fields ?? []).find((f: { key: string }) => f.key === fieldKey);
      // A select's stored value is not what a reader should be shown.
      if (field && typeof value === "string") return optionLabel(field, value);
      if (field?.kind === "recurrence" && typeof value === "object") {
        const rec = value as { frequency?: string; interval?: number };
        return rec.frequency ? `every ${rec.interval ?? 1} ${rec.frequency}` : "";
      }
      if (typeof value === "object") return "";
      return String(value);
    };

    const arrangement = orderOf(row);
    const grouping = keyOf(arrangement.groupBy);
    const cachedQuery = mirror.get(`query.${id}`);
    const matching = cachedQuery ? new Set(JSON.parse(cachedQuery) as string[]) : null;
    // What makes a collection smart is the mode it was put in, not the presence
    // of a saved query — a manual collection can carry one from before it was
    // switched back, and reading that as smart hid every card someone had
    // placed by hand.
    //
    // The mode is on `membership` now. It used to be `properties.membership_mode`,
    // and reading the old place found nothing, so every board answered "not
    // smart" and stopped intersecting with its query — which is why cards whose
    // dates had fallen out of range went on being shown. Nothing failed. The
    // filtering just quietly stopped happening, which is the shape of every
    // vocabulary change that is read by the wrong name.
    const isSmart = row.membership?.mode === "query" && matching !== null;

    const idx = types();
    const placed = new Set<string>();
    const unplaced: unknown[] = [];
    const cells: Record<string, unknown[]> = {};
    for (const r of regions) cells[String(r.index)] = [];
    for (const m of mirror.membersOf(id)) {
      const block = JSON.parse(m.raw);
      const c = toCanonical(block, block.type ? idx.get(block.type) : undefined, {
        appOrigin: config.origin,
        collectionKind: block.collectionKind ?? null,
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
        dates: datesOf(m.raw),
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
        const c = toCanonical(b, b.type ? idx.get(b.type) : undefined, {
          appOrigin: config.origin,
          collectionKind: b.collectionKind ?? null,
        });
        if (c.archivedAt) continue;
        drawer.push({
          dates: datesOf(r),
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
      /**
       * Who is in a collection, preferring what the envelope said.
       *
       * This used to prefer the cached answer from Hermes' own `/blocks/query`,
       * because a dynamic smart collection arrived with an empty `members` and
       * there was nothing else to draw. The producer now ships the evaluated
       * set as the snapshot the format allows beside `materialized: false`, so
       * the envelope has it and the binding is enough.
       *
       * The cache stays as a fallback rather than being deleted, and that is
       * the point rather than caution: a producer is *permitted* to ship no
       * snapshot — under `materialized: false` the query is the truth and the
       * members are a courtesy — so a consumer that fell over without one would
       * be reading the format wrong. This reads it right: use the snapshot when
       * there is one, ask when there is not, and work either way.
       */
      const membersOfCollection = (cid: string): string[] => {
        const declared = mirror.membersOf(cid).map((m) => (JSON.parse(m.raw) as { id: string }).id);
        if (declared.length) return declared;
        const cached = mirror.get(`query.${cid}`);
        return cached ? (JSON.parse(cached) as string[]) : [];
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

    /**
     * One sortable value off a card, by the same route `groupLabelFor` takes.
     *
     * The raw block rather than the canonical one, for the same reason: a sort
     * can name any field on any type, and the canonical form deliberately keeps
     * only what every surface needs. The *stored* value, not the label — a
     * select sorts by the order somebody put its options in as often as not,
     * and either way a heading's wording is not a sort key.
     */
    const valueUnder = (cardId: string, key: string | null): unknown => {
      if (!key) return undefined;
      const rawBlock = mirror.rawBlock(cardId);
      if (!rawBlock) return undefined;
      const b = JSON.parse(rawBlock) as { type?: string | null; properties?: Record<string, unknown> };
      // The type's *name*: nobody sorts a list by opaque ids, and the name is
      // what the heading says. Grouping wants the id and gets it elsewhere.
      if (key === "type") return b.type ? (types().get(b.type)?.name ?? b.type) : undefined;
      if (key === "created" || key === "edited") {
        const c = canon([rawBlock])[0] as { createdAt?: string; updatedAt?: string } | undefined;
        return key === "created" ? c?.createdAt : c?.updatedAt;
      }
      if (!key.startsWith("prop:")) return undefined;
      const raw2 = key.slice(5);
      for (const part of ["start", "end"]) {
        if (raw2.endsWith(`.${part}`)) {
          const v = b.properties?.[raw2.slice(0, -(part.length + 1))] as Record<string, unknown> | null;
          return v?.[part];
        }
      }
      return b.properties?.[raw2];
    };

    /**
     * The collection's own arrangement, applied.
     *
     * The rows arrive in `position` order, which is the answer when the
     * collection says nothing — somebody dragged them there. When it does say,
     * that order becomes the tiebreak rather than the answer, so a sort naming
     * no second key is still stable.
     *
     * Missing values go last in both directions. A list sorted by due date
     * descending should show the furthest-out dated thing first and the undated
     * ones at the bottom, not a screen of undated cards above everything real.
     */
    const arrange = <T extends { id: string }>(cards: T[]): T[] => {
      const levels = arrangement.sort ?? [];
      if (!levels.length) return cards;
      const blank = (v: unknown) => v === undefined || v === null || v === "";
      return [...cards].sort((x, y) => {
        for (const lv of levels) {
          const [a, b] = [valueUnder(x.id, keyOf(lv.by)), valueUnder(y.id, keyOf(lv.by))];
          if (blank(a) || blank(b)) {
            if (blank(a) && blank(b)) continue;
            return blank(a) ? 1 : -1;
          }
          const c =
            typeof a === "number" && typeof b === "number"
              ? a < b
                ? -1
                : a > b
                  ? 1
                  : 0
              : String(a) < String(b)
                ? -1
                : String(a) > String(b)
                  ? 1
                  : 0;
          if (c) return lv.direction === "descending" ? -c : c;
        }
        return 0;
      });
    };

    // A rollup's headings are its contents. It owns no memberships, so `members`
    // below is empty by construction and the sort would reach nothing at all
    // unless it is applied here as well.
    if (isRollup && groups.length) {
      const sorted = arrange(groups as { id: string }[]);
      groups.length = 0;
      groups.push(...sorted);
    }

    const me = canon([raw])[0]!;
    // A sequence collection puts everything in one list; there are no regions to
    // put anything in, so what would have been "unplaced" is simply the contents.
    const members: unknown[] = gridded ? [] : arrange(drawer.slice() as { id: string }[]);
    // Named apart from the `placed` set above, which tracks something else
    // entirely: this is "has coordinates on the canvas".
    const positioned = members.filter((m) => (m as { x: number | null }).x !== null);

    // Tables carry their cells alongside the cards, so a view can draw either.
    const isTable = row.collectionKind === "table";
    const columns = isTable ? tableColumns() : [];
    const rowsOut = isTable
      ? members.map((m) => {
          const card = m as { id: string };
          const raw = mirror.rawBlock(card.id);
          return {
            id: card.id,
            cells: raw ? Object.fromEntries(columns.map((c) => [c.key, cellValue(raw, c.key)])) : {},
          };
        })
      : [];

    // "Show existing connections": an arrow between any two boxes whose blocks
    // already link, which is a different thing from the connections somebody
    // drew. Those are decoration on the collection; these are the real
    // relationships the blocks already have — a task pointing at its project —
    // and the canvas is set to show them.
    const showLinks = isCanvas && props.canvas_show_links === true;
    const linkEdges: unknown[] = [];
    if (showLinks) {
      const onCanvas = new Set(positioned.map((c) => (c as { id: string }).id));
      for (const id of onCanvas) {
        const raw = mirror.rawBlock(id);
        if (!raw) continue;
        const b = JSON.parse(raw);
        const c = toCanonical(b, b.type ? idx.get(b.type) : undefined, {
          appOrigin: config.origin,
          collectionKind: b.collectionKind ?? null,
        });
        for (const link of c.links) {
          // Only between two things actually on this canvas: an arrow to
          // somewhere off-screen has nowhere to point.
          if (!onCanvas.has(link.id) || link.id === id) continue;
          linkEdges.push({
            from: id,
            to: link.id,
            fromSide: "e",
            toSide: "w",
            dash: "solid",
            arrow: "forward",
            width: 1.5,
            color: null,
            label: null,
            derived: true,
          });
        }
      }
    }

    return envelope({
      id,
      title: me.title,
      // The collection's own address in the web app, so a panel can hand off to
      // the full thing rather than being a dead end when it can't do something.
      url: me.url,
      kind: row.collectionKind,
      gridded,
      cols,
      rows,
      regions: gridded ? regions : [],
      cells: gridded ? cells : {},
      drawer: gridded ? drawer : [],
      members,
      canvas: isCanvas,
      table: isTable,
      columns,
      tableRows: rowsOut,
      rollup: isRollup,
      groups,
      // What the grouping is called, so a view can say what it is grouping by
      // rather than presenting unexplained headings.
      groupBy: grouping,
      notes,
      edges: [...edges, ...linkEdges],
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
    const { days, date, collection } = z
      .object({
        days: z.coerce.number().int().min(1).max(60).optional(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        /** Scope to one collection: its members, laid out by day. */
        collection: z.string().uuid().optional(),
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
    // A collection shows what is in it, and a subscribed calendar is not in it.
    // Feed events are a third party's, they are not blocks, and no membership
    // names them — so a collection view carrying them is showing things that
    // are not its contents. They belong to the agenda, which is a view over
    // everything and says so.
    //
    // It also means this path asks Hermes nothing: scoped to a collection, the
    // whole answer comes from the mirror, which the binding fills.
    try {
      if (collection) throw new OfflineError("scoped to a collection");
      const got = await hermes.feedEvents(start, end);
      feed = got.events;
      feedStale = got.stale;
      mirror.set(`feed.${start}.${end}`, JSON.stringify(feed));
    } catch {
      const cached = collection ? null : mirror.get(`feed.${start}.${end}`);
      if (cached) {
        feed = JSON.parse(cached) as unknown[];
        // Served from the last copy, which is worth saying: an agenda missing
        // half its meetings should not look like a quiet afternoon.
        feedStale = true;
      }
    }

    const idx = types();
    // Scoped to a collection: exactly its members. A smart one is whatever its
    // query answered, an explicit one is what was put in it — the same two
    // answers the board view uses, so a calendar and a list of the same
    // collection cannot disagree about what is in it.
    let scope: Set<string> | null = null;
    if (collection) {
      const raw = mirror.rawBlock(collection);
      const board = raw ? (JSON.parse(raw) as { membership?: { mode?: string } }) : null;
      const cachedIds = mirror.get(`query.${collection}`);
      scope =
        board?.membership?.mode === "query" && cachedIds
          ? new Set(JSON.parse(cachedIds) as string[])
          : new Set(mirror.membersOf(collection).map((m) => (JSON.parse(m.raw) as { id: string }).id));
    }
    const blocks = canon(mirror.search({ limit: 500 })).filter(
      (b) => !b.archivedAt && !b.collectionKind && (scope === null || scope.has(b.id)),
    );
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
          // Both ends, always. A thing that runs from nine to half past has two
          // times, and showing one of them next to a label describing the other
          // is how an eight o'clock start came to be captioned "end".
          start: b.schedule?.start?.allDay === false ? b.schedule?.start?.value ?? null : null,
          end: b.schedule?.end?.allDay === false ? b.schedule?.end?.value ?? null : null,
          startsToday: s === date,
          endsToday: e === date,
          // The field's own name for its far end, not the word "due". A task's
          // datespan ends on a due date; an event's simply stops. Only worth
          // saying on a span that reaches past today — on a single day the two
          // times say it themselves.
          endLabel: e === date && s !== e ? b.schedule?.endLabel ?? null : null,
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
        // Feed events have always carried an end; dropping it here is why a
        // meeting showed the hour it began and nothing about when it stopped.
        end: raw.end === null || raw.end === undefined ? null : String(raw.end),
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

  /**
   * The types, and what each one is made of.
   *
   * `fields` is here so a composer can be built without knowing what a Task is.
   * Every field carries its own kind, label and options, which is the whole
   * reason a form can be drawn from this rather than written per type — and the
   * reason it must be: types are rows the user can rename and reshape, so a
   * panel with a Task-shaped form hardcoded in it is wrong the first time
   * somebody adds a field.
   */
  app.get("/types", async () =>
    envelope(
      [...types().values()].map((t) => ({
        id: t.id,
        name: t.name,
        fields: t.fields ?? [],
        // Which slot a body goes in, when the type declares one. A text type
        // keeps its prose in `content`, outside the property bag entirely.
        bodySlot: typeof t.profiles?.note?.body === "string" ? (t.profiles.note.body as string) : null,
        titleKey: typeof t.profiles?.task?.title === "string" ? (t.profiles.task.title as string) : null,
      })),
    ),
  );

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

    // The note profile says where a body lives. `content` is the reserved slot
    // outside the property bag, so it is not a property key and must not be
    // written as one.
    const bodySlot = type?.profiles?.note?.body;
    const prose = typeof bodySlot === "string" && bodySlot !== "content" ? bodySlot : null;
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
      const row = JSON.parse(raw) as { version: number; type?: string | null };
      const type = row.type ? types().get(row.type) : undefined;
      const status = body.status ?? (type?.profiles?.task?.completeValues as string[] | undefined)?.[0];
      if (!status) return reply.code(400).send({ error: "that block's type has no completed status" });
      baseVersion = row.version;
      intent = { kind: "complete", blockId: body.blockId, status };
    } else if (body.kind === "move") {
      // Asked before the local placement below, which would otherwise make
      // every card look like an existing member.
      const join = !mirror.isMember(body.collectionId, body.blockId);
      const boardRaw = mirror.rawBlock(body.collectionId);
      const boardRow = boardRaw ? JSON.parse(boardRaw) : null;
      intent = {
        kind: "move",
        collectionId: body.collectionId,
        blockId: body.blockId,
        region: body.region,
        join,
        // Read before the local placement overwrites it.
        fromRegion: mirror.regionOf(body.collectionId, body.blockId),
      };
      // Show the card in its new cell straight away. The sync loop will confirm
      // it, and a drag that snapped back while the request was in flight would
      // read as the drag having failed.
      mirror.placeLocally(
        body.collectionId,
        body.blockId,
        body.region,
        body.region === null ? null : regionNameAt(boardRow, body.region),
      );
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
        // A refused write has to undo the optimistic placement, or the mirror
        // keeps a move the producer never accepted. Nothing would correct it: a
        // delta only carries objects that changed, and on the far side nothing
        // did — so the card sits in the wrong cell until the next full read,
        // which may be never. Two stores quietly disagreeing, with the person
        // who moved it told nothing, is the exact failure this format exists to
        // make impossible, and it was happening inside the client.
        if (intent.kind === "move") {
          const raw = mirror.rawBlock(intent.collectionId);
          mirror.placeLocally(
            intent.collectionId,
            intent.blockId,
            intent.fromRegion,
            intent.fromRegion === null ? null : regionNameAt(raw ? JSON.parse(raw) : null, intent.fromRegion),
          );
        }
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
      // Through the binding, like the queued path beside it. Both routes to a
      // create used `hermes.createBlock`; leaving one of them behind would have
      // meant the online path reaching past the format and the offline path not,
      // which is the sort of split nobody finds until the two disagree.
      await ix.put(intent.id, {
        type: intent.blockTypeId,
        content: intent.content,
        properties: intent.properties,
      });
      return { id: intent.id };
    }
    if (intent.kind === "move") {
      // A region name, through the binding. Which cell that is on the grid is
      // this producer's business and stops at its edge.
      const board = mirror.rawBlock(intent.collectionId);
      const answer = await ix.place(
        intent.collectionId,
        intent.blockId,
        intent.region === null ? null : regionNameAt(board ? JSON.parse(board) : null, intent.region),
      );
      if (!answer.ok) throw new HermesError(400, "that region is not on this board");
      // What the region does to what lands in it — the tag, and the status if
      // it sets one. Without this a board records an arrangement instead of
      // making it.
      await applyRegionActions(ix, hermes, mirror, intent);
      return { id: intent.blockId };
    }
    if (intent.kind === "complete") {
      // From the mirror rather than a fresh read: the version travels with the
      // object now, so there is nothing left to fetch first. A stale one is
      // refused rather than merged, which is the answer we want anyway.
      const raw = mirror.rawBlock(intent.blockId);
      if (!raw) throw new HermesError(404, "block not found");
      const current = JSON.parse(raw) as { type?: string | null; version?: number };
      const statusKey = types().get(current.type ?? "")?.profiles?.task?.status;
      if (typeof statusKey !== "string") throw new HermesError(400, "that type declares no task status");
      const answer = await ix.patch(intent.blockId, {
        set: { [statusKey]: intent.status },
        version: current.version ?? 0,
      });
      if (!answer.ok) throw new HermesError(answer.conflict ? 409 : 400, "the write was refused");
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
    const row: InterchangeObject = {
      id,
      ...(intent.blockTypeId ? { type: intent.blockTypeId } : {}),
      ...(intent.content ? { content: intent.content } : {}),
      properties: intent.properties ?? {},
      version: 0, // not yet a producer's version; nothing may patch on this
      archived: false,
      created: now,
      updated: now,
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
        typeId: row.type ?? null,
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
