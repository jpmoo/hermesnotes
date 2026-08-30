import { blockTags, blockTypes, blocks, changes, memberships, series, tags } from "@hermes/db";
import { CONFORMANCE, narrow, regionNamesOf, toInterchange } from "@hermes/interchange";
import { and, eq, gt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { FilterQuery } from "@hermes/shared";
import { authenticate, requireUser } from "../auth/middleware.js";
import { runQuery } from "../collections/query.js";
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
      ["POST", `${mount}/blocks`],
      ["GET", `${mount}/blocks/:id`],
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
        .object({
          since: z.string().optional(),
          profile: z.string().optional(),
          // One collection, evaluated now. See the route below, which is the
          // documented spelling of this — the parameter exists so there is one
          // implementation rather than two, not because anybody should reach
          // for it directly.
          collection: z.string().uuid().optional(),
        })
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

      /**
       * What each live smart collection currently matches.
       *
       * A dynamic smart collection has no membership rows, so without this it
       * exports as a name and a query and nothing else — and a consumer with no
       * query engine can show a person the collection exists and not what is in
       * it. Talaria was solving that by asking Hermes' own `/blocks/query`,
       * reaching past the binding for the one thing it exists to carry.
       *
       * Shipped as the snapshot the format permits beside `materialized: false`:
       * the query stays the truth, this is a courtesy, and a consumer is
       * forbidden from treating it as authoritative. Capped for the same reason
       * the graph builder caps it — an export should not become unbounded work
       * because somebody made a hundred saved searches.
       */
      const queryMembers = new Map<string, string[]>();
      let evaluated = 0;
      const SMART_QUERY_CAP = 80;
      // The one that was asked for goes first. Otherwise a library with more
      // than eighty saved searches could answer this route with a stale list
      // for the single collection somebody asked to have refreshed, which is
      // the one thing it is for.
      const ordered = q.collection ? [...rows].sort((a, b) => (a.id === q.collection ? -1 : b.id === q.collection ? 1 : 0)) : rows;
      for (const c of ordered) {
        if (evaluated >= SMART_QUERY_CAP) break;
        if (!c.collectionKind) continue;
        const props = (c.properties ?? {}) as Record<string, unknown>;
        if (props.membership_mode !== "smart") continue;
        // A snapshot smart collection already has its rows; re-evaluating would
        // overwrite a set somebody deliberately froze.
        if (props.smart_mode === "snapshot") continue;
        const filter = props.filter_query as FilterQuery | undefined;
        if (!filter) continue;
        evaluated += 1;
        try {
          const matches = await runQuery(userId, filter);
          queryMembers.set(c.id, matches.map((m) => m.id));
        } catch {
          // A broken filter costs its own collection and nothing else.
        }
      }

      const { envelope, findings } = toInterchange({
        queryMembers,
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

      const answer = { ...narrow(envelope, delta, q.profile), cursor, findings } as Record<string, unknown> & {
        types?: { id: string }[];
        objects?: { id: string; type?: string }[];
        collections?: { id: string; members?: (string | { object?: string })[] }[];
      };
      if (!q.collection) return answer;

      /**
       * One collection, with what it needs to be drawn.
       *
       * The members as objects and those objects' types, because a consumer
       * asks this *because* it cannot run the query — a list of ids it has
       * nothing to resolve against is an answer that is current and unusable.
       * `collection.member-not-carried` is the rule, and this is the code it
       * exists to keep honest.
       */
      const only = (answer.collections ?? []).find((c) => c.id === q.collection);
      if (!only) return reply.code(404).send({ error: "no such collection" });
      const wanted = new Set(
        (only.members ?? [])
          .map((m) => (typeof m === "string" ? m : m?.object))
          .filter((id): id is string => Boolean(id)),
      );
      const objects = (answer.objects ?? []).filter((o) => wanted.has(o.id));
      const used = new Set(objects.map((o) => o.type).filter(Boolean));
      return {
        ...answer,
        types: (answer.types ?? []).filter((t) => used.has(t.id)),
        objects,
        collections: [only],
      };
    });

    /**
     * What a collection holds now.
     *
     * The one route a consumer with no query engine needs and a cursor cannot
     * replace: a computed membership changes without anything changing, so a
     * follower catching up on every event still holds a list that quietly
     * stopped being true. A task whose date fell into range today was not
     * edited.
     *
     * Delegated rather than reimplemented, like every other verb here. The
     * evaluation, the narrowing rules, the addresses and the findings all live
     * in the read above; this is its documented spelling.
     */
    guarded.get("/interchange/collections/:id", async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const res = await app.inject({
        method: "GET",
        url: `/api/interchange?collection=${id}`,
        headers: { authorization: req.headers.authorization ?? "" },
        cookies: (req.cookies ?? {}) as Record<string, string>,
      });
      return reply.code(res.statusCode).send(res.json());
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
    /**
     * Bringing an object into being, at an id the client picked.
     *
     * Creates and never edits, which is the whole reason it is a separate verb
     * from PATCH rather than a mode of it. A PUT that replaced would discard
     * every property the caller had never heard of — the round-trip rule broken
     * at write time, by the verb least likely to be suspected of it — so an id
     * that is already taken is answered as a success that changed nothing.
     *
     * That is also what makes it safe for a queue to replay. The client chose
     * the id before it sent anything, so a retry after a lost answer is
     * recognisably the same create rather than a second radiator.
     */
    guarded.put("/interchange/objects/:id", async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({
          id: z.string().optional(),
          type: z.string().uuid().optional(),
          properties: z.record(z.unknown()).optional(),
          content: z.string().optional(),
        })
        .parse(req.body ?? {});

      // Two ids in one request is a client bug, and picking one is how an
      // object is created somewhere nobody will look for it.
      if (body.id !== undefined && body.id !== id) {
        return reply.code(400).send({ ok: false, reports: ["create.id-mismatch"] });
      }

      // Already there? Then this is a repeat, and the answer is the object as
      // it stands — untouched.
      const before = await app.inject({
        method: "GET",
        url: `${mount}/blocks/${id}`,
        headers: { authorization: req.headers.authorization ?? "" },
      });
      if (before.statusCode < 400) {
        const env = await app.inject({
          method: "GET",
          url: `${mount}/interchange`,
          headers: { authorization: req.headers.authorization ?? "" },
        });
        const read = env.json() as { cursor?: string; objects?: { id: string }[] };
        return reply.code(200).send({
          ok: true,
          created: false,
          fidelity: "full",
          reports: [],
          cursor: read.cursor,
          object: (read.objects ?? []).find((o) => o.id === id),
        });
      }

      // A type the producer does not have. Reported rather than invented — this
      // is the one write with no earlier version to compare against, so a
      // reduction nobody mentions is invisible for good.
      const reports: string[] = [];
      if (body.type) {
        const known = await db
          .select({ id: blockTypes.id })
          .from(blockTypes)
          .where(and(eq(blockTypes.id, body.type), eq(blockTypes.ownerId, requireUser(req))));
        if (!known.length) reports.push("create.unknown-type");
      }

      const made = await app.inject({
        method: "POST",
        url: `${mount}/blocks`,
        headers: { authorization: req.headers.authorization ?? "", "content-type": "application/json" },
        payload: { id, blockTypeId: body.type, properties: body.properties, content: body.content },
      });
      if (made.statusCode >= 400) {
        return reply.code(made.statusCode).send({ ok: false, reports: ["write.refused"] });
      }

      // Read back the way a reader would, so the object in this answer is the
      // object the next `?since=` will carry.
      const after = await app.inject({
        method: "GET",
        url: `${mount}/interchange`,
        headers: { authorization: req.headers.authorization ?? "" },
      });
      const env = after.json() as { cursor?: string; objects?: { id: string }[] };
      return reply.code(201).send({
        ok: true,
        created: true,
        fidelity: reports.length ? "reduced" : "full",
        reports,
        cursor: env.cursor,
        object: (env.objects ?? []).find((o) => o.id === id),
      });
    });

    guarded.patch("/interchange/objects/:id", async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({
          set: z.record(z.unknown()).optional(),
          unset: z.array(z.string()).optional(),
          addTags: z.array(z.string()).optional(),
          removeTags: z.array(z.string()).optional(),
          version: z.number().int(),
        })
        .parse(req.body);

      // A tag in both lists is a contradiction with no obviously right reading.
      const add = body.addTags ?? [];
      const drop = body.removeTags ?? [];
      if (add.some((t) => drop.includes(t))) {
        return reply.code(400).send({ ok: false, reports: ["tags.added-and-removed"] });
      }

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

      // Tags after the properties, and only once they were accepted.
      //
      // The version check lives in the property patch. Writing tags first meant
      // a stale patch was refused *after* the tags had already changed — a
      // partial write, which is the one outcome worse than a refusal, because
      // the caller is told nothing landed while something did.

      // Amended, never replaced. Hermes' own route takes the whole list, so the
      // read-and-merge has to happen somewhere — here, once, rather than in
      // every client that wants to add a tag. That merge is exactly what
      // Talaria was doing across two round trips against private routes, which
      // is the limit this verb closes.
      if (add.length || drop.length) {
        const held = await app.inject({
          method: "GET",
          url: `${mount}/blocks/${id}/tags`,
          headers: { authorization: req.headers.authorization ?? "" },
        });
        const current = held.statusCode < 400 ? (held.json() as string[]) : [];
        const next = current.filter((t) => !drop.includes(t));
        for (const t of add) if (!next.includes(t)) next.push(t);
        const put = await app.inject({
          method: "PUT",
          url: `${mount}/blocks/${id}/tags`,
          headers: { authorization: req.headers.authorization ?? "", "content-type": "application/json" },
          payload: { tags: next },
        });
        if (put.statusCode >= 400) {
          return reply.code(put.statusCode).send({ ok: false, reports: ["tags.refused"] });
        }
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
