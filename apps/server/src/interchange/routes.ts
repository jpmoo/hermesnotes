import { blockTags, blockTypes, blocks, changes, memberships, series, tags } from "@hermes/db";
import { CONFORMANCE, narrow, regionNamesOf, toInterchange } from "@hermes/interchange";
import { and, eq, gt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, requireUser } from "../auth/middleware.js";
import { db } from "../db.js";
import { env } from "../env.js";

/**
 * The interchange binding: what this instance honours, and everything it holds.
 *
 * These two routes are what make the `http` binding a fact rather than a claim.
 * The manifest went live first, saying `produce: 4` over http, while the only
 * way to actually get an export was to run a script in the repository — so a
 * client reading the manifest would have concluded it could fetch one, and it
 * could not. A promise the data does not back is the exact failure the manifest
 * rule exists to catch, and it caught its own author.
 */
export async function interchangeRoutes(app: FastifyInstance): Promise<void> {
  // Where this plugin was mounted. The writes below delegate to Hermes' own
  // handlers through `app.inject`, which goes through the whole routing table —
  // prefix included — so a bare `/blocks/:id` matches nothing and answers 404.
  // It did, live, while every read passed: the refusal paths never reach the
  // inject, so both write routes looked healthy right up until one was asked to
  // work. Read from the instance rather than written down, so remounting the
  // API somewhere else does not quietly break writing again.
  const mount = app.prefix ?? "";

  /**
   * The delegates have to exist, and this is the only place that can tell.
   *
   * A binding that translates into another route is one typo away from
   * answering 404 to every write while every read stays green — the refusal
   * paths short-circuit before they delegate, so the routes look healthy until
   * somebody asks one to work. That is a boot-time fact, so it is checked at
   * boot rather than discovered by a client.
   */
  app.addHook("onReady", async () => {
    const needed: [string, string][] = [
      ["PATCH", `${mount}/blocks/:id`],
      ["GET", `${mount}/interchange`],
      ["PATCH", `${mount}/collections/:id/members/:blockId`],
    ];
    const missing = needed.filter(([method, url]) => !app.hasRoute({ method: method as "GET", url }));
    if (missing.length) {
      throw new Error(
        `the interchange binding delegates to routes that do not exist: ${missing
          .map(([m, u]) => `${m} ${u}`)
          .join(", ")}`,
      );
    }
  });

  /**
   * Unauthenticated on purpose: it says what the software can do, not what any
   * account holds. A client deciding whether it can talk to this server at all
   * should not need credentials to find out — and an agent that has to attempt a
   * write to learn whether it is supported has already done the damage if it
   * isn't.
   */
  //
  // It is safe to leave open only because CONFORMANCE is a constant. It says
  // what this build implements and never touches the database, so
  // `profiles: ["task", "note"]` is a fact about the software rather than a
  // statement that this account keeps tasks and notes. It also gives away no
  // fingerprint the site does not: the web app is served at this origin and
  // announces itself to anyone who loads the page.
  //
  // If it ever becomes computed — the account's real types, the collections it
  // holds — it stops being safe and has to move behind `authenticate`. That is
  // the line, and it is here rather than in a commit message because this is
  // where somebody would cross it.
  app.get("/conformance", async () => CONFORMANCE);

  app.register(async (guarded) => {
    guarded.addHook("preHandler", authenticate);

    /**
     * Everything this account holds, as one envelope.
     *
     * `findings` travels with it, which is unusual for an export and is the
     * point: it lists what Hermes could not say, in the format's own vocabulary,
     * rather than leaving a reader to notice the absence. An export that reports
     * nothing is claiming to have lost nothing.
     */
    guarded.get("/interchange", async (req, reply) => {
      const userId = requireUser(req);
      const q = z
        .object({ since: z.string().optional(), profile: z.string().optional() })
        .parse(req.query);

      // Where this answer was taken. The change log's high-water mark, so it
      // moves exactly when something moved. Opaque to the caller by contract —
      // it is a sequence number here and has no business being one anywhere
      // else.
      const [head] = await db
        .select({
          seq: sql<string | null>`pg_sequence_last_value(pg_get_serial_sequence('changes', 'seq')::regclass)`,
          oldest: sql<string | null>`MIN(${changes.seq})`,
        })
        .from(changes);
      const cursor = String(head?.seq == null ? 0 : Number(head.seq));

      let delta: { rows: { blockId: string; op: string; seq: number }[] } | null = null;
      if (q.since !== undefined) {
        const since = Number(q.since);
        if (!Number.isFinite(since) || since < 0) {
          return reply.code(400).send({ error: "since must be a cursor from a previous read" });
        }
        // Rows age out at seven days. A caller from before the oldest one we
        // still hold cannot be caught up by a delta, and the one thing we must
        // not do is answer with the part we happen to have — that produces a
        // follower quietly missing objects with nothing to tell it so.
        //
        // `oldest` is deliberately global while the delta below is this owner's.
        // That looks like a mismatch and is safe, for a reason worth writing
        // down rather than re-deriving: pruning is by *age* and takes no notice
        // of who wrote a row, so the global minimum sits at the retention cutoff
        // for everybody. If `since` is at or above it, nothing older than
        // `since` was pruned for anyone — this owner included — so the delta is
        // complete. A global minimum can only be lower than this owner's, so the
        // check can refuse a caller who had lost nothing, and can never wave
        // through one who has. Erring toward a needless full read is the right
        // direction to err in.
        const oldest = head?.oldest == null ? null : Number(head.oldest);
        const pruned = oldest === null ? since < Number(cursor) : since + 1 < oldest;
        if (pruned) {
          return reply
            .code(410)
            .send({ error: "that cursor is older than the change log. Read again without `since`." });
        }
        const rows = await db
          .select({ blockId: changes.blockId, op: changes.op, seq: changes.seq })
          .from(changes)
          .where(and(eq(changes.ownerId, userId), gt(changes.seq, since)));
        delta = { rows };
      }
      const types = await db
        .select({
          id: blockTypes.id,
          name: blockTypes.name,
          isText: blockTypes.isText,
          propertySchema: blockTypes.propertySchema,
        })
        .from(blockTypes)
        .where(eq(blockTypes.ownerId, userId));

      const rows = await db
        .select({
          id: blocks.id,
          blockTypeId: blocks.blockTypeId,
          collectionKind: blocks.collectionKind,
          content: blocks.content,
          properties: blocks.properties,
          archivedAt: blocks.archivedAt,
          createdAt: blocks.createdAt,
          updatedAt: blocks.updatedAt,
          seriesId: blocks.seriesId,
          version: blocks.version,
        })
        .from(blocks)
        .where(eq(blocks.ownerId, userId));

      // Tags. The exporter has always known how to emit these and this query
      // never fetched them, so every export went out with none — a whole
      // dimension of somebody's filing, silently absent, in a format that has a
      // field for it. Nothing reported it because nothing was wrong: the rows
      // simply said they had no tags.
      const tagRows = await db
        .select({ blockId: blockTags.blockId, name: tags.name })
        .from(blockTags)
        .innerJoin(tags, eq(tags.id, blockTags.tagId))
        .innerJoin(blocks, eq(blocks.id, blockTags.blockId))
        .where(and(eq(blocks.ownerId, userId), eq(tags.ownerId, userId)))
        .orderBy(tags.name);
      const tagsByBlock = new Map<string, string[]>();
      for (const t of tagRows) tagsByBlock.set(t.blockId, [...(tagsByBlock.get(t.blockId) ?? []), t.name]);

      const seriesRows = await db
        .select({ id: series.id, rule: series.rule })
        .from(series)
        .where(eq(series.ownerId, userId));

      const mem = await db
        .select({
          collectionId: memberships.collectionId,
          blockId: memberships.blockId,
          position: memberships.position,
          context: memberships.context,
        })
        .from(memberships)
        .innerJoin(blocks, and(eq(blocks.id, memberships.blockId), eq(blocks.ownerId, userId)));

      const { envelope, findings } = toInterchange({
        types: types.map((t) => ({ ...t, propertySchema: t.propertySchema ?? null })),
        blocks: rows.map((b) => ({
          ...b,
          properties: (b.properties ?? {}) as Record<string, unknown>,
          archivedAt: b.archivedAt ? b.archivedAt.toISOString() : null,
          createdAt: b.createdAt.toISOString(),
          updatedAt: b.updatedAt.toISOString(),
          tags: tagsByBlock.get(b.id) ?? [],
        })),
        memberships: mem.map((m) => ({
          collectionId: m.collectionId,
          blockId: m.blockId,
          position: m.position,
          context: (m.context ?? {}) as Record<string, unknown>,
        })),
        seriesRows,
        producer: { name: "hermes", version: "2.0.0" },
        // Where a person can go to see any of this.
        //
        // Derived from the request until it turned out that a request does not
        // know. Behind a proxy that strips a path prefix — this app is served
        // at /hermesnotes — the server sees `/api/...` and has no way to learn
        // what came before it, so every address it published was a 404, stated
        // confidently. Which is worse than publishing none: the format is
        // careful that an id is opaque precisely so nobody constructs one of
        // these, and then the producer constructed a wrong one.
        //
        // `PUBLIC_BASE` is that value and already exists, because the OAuth
        // metadata endpoints need the same thing. That is also what answers the
        // original objection to configuration: it cannot drift quietly, since
        // anything that breaks these addresses breaks discovery in the same
        // stroke and much more loudly.
        //
        // Absent, the request is still the best guess and is right for the
        // ordinary case of an app served at the root.
        origin: env.PUBLIC_BASE?.replace(/\/$/, "") ?? `${req.protocol}://${req.hostname}`,
      });

      return { ...narrow(envelope, delta, q.profile), cursor, findings };
    });

    /**
     * A partial write, in the format's words.
     *
     * Deliberately a translation layer over Hermes' own write rather than a
     * second implementation of it. Completing a task stamps a completion time,
     * keeps the series in step and spawns the next occurrence — 125 lines of
     * consequence that a binding has no business owning a copy of. So the
     * vocabulary is translated in, Hermes' handler does the work, and the answer
     * is translated back out. A binding that grows its own business logic is two
     * apps in one process waiting to disagree.
     */
    guarded.patch("/interchange/objects/:id", async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({
          set: z.record(z.unknown()).optional(),
          unset: z.array(z.string()).optional(),
          version: z.number().int(),
        })
        .parse(req.body);

      const wrote = await app.inject({
        method: "PATCH",
        url: `${mount}/blocks/${id}`,
        headers: { authorization: req.headers.authorization ?? "", "content-type": "application/json" },
        payload: { patch: { set: body.set, unset: body.unset }, version: body.version },
      });

      if (wrote.statusCode === 409) {
        // Refused, not merged. The one answer a stale patch is allowed.
        return reply.code(409).send({ ok: false, conflict: true, reports: ["version.stale"] });
      }
      if (wrote.statusCode >= 400) {
        return reply.code(wrote.statusCode).send({ ok: false, reports: ["write.refused"] });
      }

      // Read back through the same path a reader would use, so the object in
      // this answer is the object the next `?since=` will carry — including
      // whatever the write did that the caller never asked for.
      const after = await app.inject({
        method: "GET",
        url: `${mount}/interchange`,
        headers: { authorization: req.headers.authorization ?? "" },
      });
      const env = after.json() as { cursor?: string; objects?: { id: string }[] };
      const object = (env.objects ?? []).find((o) => o.id === id);

      // `full`, and meant. Hermes stores a property bag, so the values in a
      // patch are kept exactly as they arrived whether or not the type declares
      // them — there is nothing here that was lost. The export's own findings
      // are about the library, not about this write, and folding them in would
      // mean answering "reduced" to everything: a field that is always set
      // carries no information, and the one write that really did lose
      // something would arrive looking like all the others.
      return { ok: true, fidelity: "full", reports: [], cursor: env.cursor, object };
    });

    /**
     * Move a card to a named region.
     *
     * Where something sits is not one of its properties — it belongs to the
     * collection, which is where a read carries it — so it is written here
     * rather than through a patch.
     *
     * The name is the whole point. Hermes stores a region as an index into a
     * grid, which means nothing to a tool that draws no grid, so the export
     * publishes slugs and this reverses them with the same function. A name the
     * collection never declared is refused rather than stored: an index nothing
     * renders is a card that has silently vanished from the board.
     */
    guarded.patch("/interchange/collections/:collection/members/:object", async (req, reply) => {
      const userId = requireUser(req);
      const { collection, object } = z
        .object({ collection: z.string().uuid(), object: z.string().uuid() })
        .parse(req.params);
      const body = z.object({ region: z.string().nullable() }).parse(req.body);

      const [board] = await db
        .select({ properties: blocks.properties, kind: blocks.collectionKind })
        .from(blocks)
        .where(and(eq(blocks.id, collection), eq(blocks.ownerId, userId)))
        .limit(1);
      if (!board) return reply.code(404).send({ ok: false, reports: ["collection.not-found"] });

      const names = regionNamesOf((board.properties ?? {}) as Record<string, unknown>);
      let index: number | null = null;
      if (body.region !== null) {
        index = names.indexOf(body.region);
        if (index < 0) {
          return reply.code(400).send({
            ok: false,
            reports: ["placement.region-not-declared"],
            error: `this collection declares ${names.length ? names.join(", ") : "no regions"}`,
          });
        }
      }

      const wrote = await app.inject({
        method: "PATCH",
        url: `${mount}/collections/${collection}/members/${object}`,
        headers: { authorization: req.headers.authorization ?? "", "content-type": "application/json" },
        // Null overwrites where an empty object would merge, so "nowhere in
        // particular" has to be said explicitly or the card never leaves.
        payload: { context: index === null ? null : { region: index } },
      });
      if (wrote.statusCode >= 400) {
        return reply.code(wrote.statusCode).send({ ok: false, reports: ["placement.refused"] });
      }
      return { ok: true, fidelity: "full", reports: [] };
    });
  });
}
