import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { bodyFieldKey } from "@hermes/shared";
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

  app.get("/types", async () => envelope([...types().values()].map((t) => ({ id: t.id, name: t.name }))));

  app.post("/sync", async () => {
    const r = await sync.catchUp();
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
