import { blockTags, blockTypes, blocks, changes, memberships, series, tags } from "@hermes/db";
import {
  CONFORMANCE,
  narrow,
  patchCollectionProps,
  placeMember,
  regionNamesOf,
  toInterchange,
} from "@hermes/interchange";
import { and, eq, gt, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
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
   * The prefix this producer's own keys travel under.
   *
   * The same name the envelope's `producer.name` carries, because a consumer
   * strips a prefix by that name and a producer that wrote a different one would
   * be handing out keys nobody can unwrap.
   */
  const PRODUCER = "hermes";

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
      ["POST", `${mount}/collections/:id/members`],
      ["DELETE", `${mount}/collections/:id/members/:blockId`],
      ["PATCH", `${mount}/collections/:id`],
      ["GET", `${mount}/search`],
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
          // Free text. Unlike the two narrowings above, this one is not
          // permission to send less — see below.
          q: z.string().max(200).optional(),
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
          iconKey: blockTypes.iconKey,
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
          version: memberships.version,
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
          version: m.version,
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

      /**
       * Free text, narrowed by Hermes' own search.
       *
       * Delegated rather than reimplemented, like every write here: the ranking
       * is literal matches by recency and then semantic neighbours the literal
       * pass missed, and a second copy of that in the binding would be a second
       * ranking to keep in step.
       *
       * The order of `objects` *is* the answer — most relevant first, and no
       * scores, because a relevance number from one producer means nothing
       * beside another's. Types travel with what survived, which is the rule for
       * every narrowing: an object whose type did not come is unreadable.
       *
       * This is the one narrowing that is not permission to send less. Ignoring
       * `since` or `profile` gives a caller more than it asked for, which is
       * safe; ignoring this one hands back the whole library labelled as
       * matches, and a tool offering "add the block you searched for" would
       * offer every block there is.
       */
      if (q.q !== undefined) {
        const term = q.q.trim();
        if (!term) return reply.code(400).send({ error: "q must not be empty" });
        const found = await app.inject({
          method: "GET",
          url: `${mount}/search?q=${encodeURIComponent(term)}`,
          headers: { authorization: req.headers.authorization ?? "" },
          cookies: (req.cookies ?? {}) as Record<string, string>,
        });
        if (found.statusCode >= 400) {
          return reply.code(503).send({ error: "search is unavailable on this instance" });
        }
        const rank = new Map(
          (found.json() as { id: string }[]).map((h, i) => [h.id, i] as const),
        );
        const objects = (answer.objects ?? [])
          .filter((o) => rank.has(o.id))
          .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
        const collections = (answer.collections ?? [])
          .filter((c) => rank.has(c.id))
          .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
        const used = new Set(objects.map((o) => o.type).filter(Boolean));
        return {
          ...answer,
          types: (answer.types ?? []).filter((t) => used.has(t.id)),
          objects,
          collections,
        };
      }

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
     * One collection, as the format describes it.
     *
     * Every write below needs the same three facts and none of them is on the
     * member: which regions exist, whether placement is a judgment or furniture,
     * and who is already a member. Read through the binding's own route so the
     * rules are applied to the same document a caller would have read, rather
     * than to Hermes' storage shape — a region is an index in the database and a
     * name in the format, and the whole point of these rules is the name.
     */
    const collectionAsRead = async (req: FastifyRequest, id: string) => {
      const res = await app.inject({
        method: "GET",
        url: `${mount}/interchange?collection=${id}`,
        headers: { authorization: req.headers.authorization ?? "" },
        cookies: (req.cookies ?? {}) as Record<string, string>,
      });
      if (res.statusCode >= 400) return null;
      const env = res.json() as { collections?: Record<string, unknown>[] };
      return (env.collections ?? [])[0] ?? null;
    };

    /**
     * Whether there is a membership row, asked of the rows.
     *
     * Not of the exported `members`, which is what this used to do and is
     * exactly wrong for the case that matters. A smart collection exports the
     * *query's answer* as its members — the format permits that beside
     * `materialized: false`, and says outright that a consumer must not treat it
     * as authoritative — so a card the query matches appears in that list
     * whether or not anybody ever placed it. Deciding "already a member" from
     * it meant a `PUT` at a card in a smart matrix's drawer answered
     * `created: false` and created nothing, and the card stayed in the drawer.
     *
     * The split is the point: the *vocabulary* of a collection — which regions
     * it declares, whether its placement is semantic — comes from the exported
     * document, because that is where the format keeps it. The *fact* of a
     * membership comes from the table that holds memberships. Reading its own
     * state to answer a question the format defines is not business logic; it is
     * the binding knowing where it lives.
     */
    const hasMembership = async (collection: string, object: string): Promise<boolean> => {
      const [row] = await db
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.collectionId, collection), eq(memberships.blockId, object)))
        .limit(1);
      return Boolean(row);
    };

    /**
     * `region` is a Hermes key inside the context bag, and must not be reachable
     * through the furniture door.
     *
     * The format keeps a member's region in `region` and its furniture in
     * `context`; Hermes keeps both in one bag, with `region` as an index. A
     * caller writing `context: { region: 2 }` would be placing a card by index
     * through the one write that exists to stop exactly that.
     */
    const REGION_KEY = "region";
    const reachesRegion = (body: { context?: Record<string, unknown>; unset?: string[] }) =>
      Object.keys(body.context ?? {}).includes(REGION_KEY) || (body.unset ?? []).includes(REGION_KEY);

    /** The placement half of a member write, in Hermes' words. */
    const placementPayload = (
      collection: Record<string, unknown>,
      body: {
        region?: string | null;
        context?: Record<string, unknown>;
        unset?: string[];
        version?: number;
      },
    ) => {
      // Carried on every shape below, because the guard belongs to the write
      // and not to one kind of write.
      const guard = body.version === undefined ? {} : { expectVersion: body.version };
      if (body.region !== undefined) {
        // Read off the declared placement, which is where the format keeps the
        // names — not off Hermes' own `matrix_regions`, which an export does not
        // carry. Reading the wrong one is how region tagging quietly stopped
        // working for months while every board still looked right.
        const declared = (
          (collection.placement as { regions?: (string | { name?: string })[] } | undefined)?.regions ?? []
        ).map((r) => (typeof r === "string" ? r : r?.name));
        const index = body.region === null ? null : declared.indexOf(body.region);
        // Null overwrites where an empty object would merge, so "nowhere in
        // particular" has to be said explicitly or the card never leaves.
        return { ...guard, context: index === null ? null : { region: index } };
      }
      return {
        ...guard,
        ...(body.context ? { context: body.context } : {}),
        ...(body.unset?.length ? { unsetContext: body.unset } : {}),
      };
    };

    const memberBody = z.object({
      region: z.string().nullable().optional(),
      context: z.record(z.unknown()).optional(),
      unset: z.array(z.string()).optional(),
      version: z.number().int().optional(),
    });

    /**
     * Move a member — to a named region, or to a place on a canvas.
     *
     * Where something sits is not one of its properties — it belongs to the
     * collection, which is where a read carries it — so it is written here
     * rather than through a patch.
     *
     * Two slots, and the collection says which applies. A region name is the
     * whole point of the first: Hermes stores an index into a grid, which means
     * nothing to a tool that draws no grid, so the export publishes slugs and
     * this reverses them. A name the collection never declared is refused rather
     * than stored, because an index nothing renders is a card that has silently
     * vanished from the board.
     *
     * `context` is the second, and is refused on a collection whose placement is
     * semantic — a judgment kept as a coordinate is a judgment nothing can read
     * back. It merges, and `unset` is the only way to remove a key: a tool that
     * drags a card sends the two numbers it moved and has never heard of the
     * size another tool put there.
     *
     * The rule lives in `@hermes/interchange`, where the fixtures can measure
     * it. This translates and delegates, like every other write here.
     */
    guarded.patch("/interchange/collections/:collection/members/:object", async (req, reply) => {
      const { collection, object } = z
        .object({ collection: z.string().uuid(), object: z.string().uuid() })
        .parse(req.params);
      const body = memberBody.parse(req.body);
      if (reachesRegion(body)) {
        return reply.code(400).send({ ok: false, reports: ["placement.region-not-declared"] });
      }

      const col = await collectionAsRead(req, collection);
      if (!col) return reply.code(404).send({ ok: false, reports: ["collection.not-found"] });

      if (!(await hasMembership(collection, object))) {
        return reply.code(404).send({ ok: false, reports: ["member.not-a-member"] });
      }
      // The member as it stands, not a bare id.
      //
      // This passed `{ object }` — a member with no context — on the reasoning
      // that the merge happens in Hermes' own route, against the row. The merge
      // does happen there, correctly. But `placeMember` also computes the
      // member this call *answers with*, and from an empty bag that answer is
      // only the keys that were patched: set `shape` on a canvas node and the
      // reply says the node has a shape and no coordinates. It does not — the
      // row is right — and a client that believed the response would drop the
      // position from its own copy and write it back.
      //
      // An answer that describes a state the row is not in is worse than no
      // answer, and the collection has already been read, so this costs a
      // lookup in a list that is already in memory.
      const members = (col as { members?: { object?: string }[] }).members ?? [];
      const current = members.find((m) => m.object === object) ?? { object };
      const decided = placeMember(col, current, body);
      if (!decided.ok) {
        return reply
          .code(decided.conflict ? 409 : 400)
          .send({ ok: false, ...(decided.conflict ? { conflict: true } : {}), reports: decided.reports });
      }

      const wrote = await app.inject({
        method: "PATCH",
        url: `${mount}/collections/${collection}/members/${object}`,
        headers: { authorization: req.headers.authorization ?? "", "content-type": "application/json" },
        payload: placementPayload(col, body),
      });
      // A stale write is a conflict and says so in the format's own shape. It
      // is answered from the row rather than from `placeMember`'s pre-check,
      // which compared against a snapshot read moments earlier and cannot see a
      // writer that arrived in between.
      if (wrote.statusCode === 409) {
        return reply.code(409).send({ ok: false, conflict: true, fidelity: "full", reports: [] });
      }
      if (wrote.statusCode >= 400) {
        return reply.code(wrote.statusCode).send({ ok: false, reports: ["placement.refused"] });
      }
      // The version the row actually reached, not the one predicted from a
      // snapshot. They agree whenever nothing else wrote; when something did,
      // the row is right and the prediction is the stale half.
      const landed = (wrote.json() as { version?: number }).version;
      const member =
        landed === undefined ? decided.member : { ...decided.member, version: landed };
      return { ok: true, fidelity: "full", reports: [], member };
    });

    /**
     * Put something on a board.
     *
     * Creates and never edits, the same division `PUT` and `PATCH` draw on an
     * object and for the same reason: a caller whose answer went missing must be
     * able to ask again without dragging somebody's card back to where it was
     * five minutes ago. A membership already there is answered as the success it
     * was, unchanged.
     *
     * It arrives with its placement, because a card that appears and then jumps
     * to where it belongs is two states somebody watching will see and only one
     * of them is true.
     */
    guarded.put("/interchange/collections/:collection/members/:object", async (req, reply) => {
      const { collection, object } = z
        .object({ collection: z.string().uuid(), object: z.string().uuid() })
        .parse(req.params);
      const body = memberBody.parse(req.body ?? {});
      if (reachesRegion(body)) {
        return reply.code(400).send({ ok: false, reports: ["placement.region-not-declared"] });
      }

      const col = await collectionAsRead(req, collection);
      if (!col) return reply.code(404).send({ ok: false, reports: ["collection.not-found"] });

      // The rules first — a region the collection never declared is refused
      // whether or not this would have created anything.
      const rules = placeMember(col, { object }, body);
      if (!rules.ok) return reply.code(400).send({ ok: false, reports: rules.reports });
      if (await hasMembership(collection, object)) {
        // It succeeded once. This is the caller asking again because it never
        // heard so, and a `PUT` never edits.
        return reply.code(200).send({ ok: true, fidelity: "full", reports: [], created: false });
      }

      const added = await app.inject({
        method: "POST",
        url: `${mount}/collections/${collection}/members`,
        headers: { authorization: req.headers.authorization ?? "", "content-type": "application/json" },
        payload: { blockId: object },
      });
      if (added.statusCode >= 400) {
        return reply.code(added.statusCode).send({ ok: false, reports: ["membership.refused"] });
      }

      // The placement goes on separately because Hermes' add takes a raw context
      // bag and the region has to be translated into an index first — the one
      // piece of vocabulary this route owns. Skipped when there is nothing to
      // place, so a plain add is one round trip.
      if (body.region !== undefined || body.context) {
        const placed = await app.inject({
          method: "PATCH",
          url: `${mount}/collections/${collection}/members/${object}`,
          headers: { authorization: req.headers.authorization ?? "", "content-type": "application/json" },
          payload: placementPayload(col, body),
        });
        if (placed.statusCode >= 400) {
          return reply.code(placed.statusCode).send({ ok: false, reports: ["placement.refused"] });
        }
      }
      return reply.code(201).send({ ok: true, fidelity: "full", reports: [], created: true, member: rules.member });
    });

    /**
     * Take something off a board.
     *
     * The membership, not the object — which goes on existing wherever else it
     * lives. This is the one write where that difference is carried entirely by
     * the verb, which is why it is worth saying rather than assuming.
     *
     * Removing something that is not a member is a success: it is the state the
     * caller asked for, and answering 404 makes every offline client special-case
     * its own retries, which is where the duplicate-and-vanish bugs come from.
     */
    guarded.delete("/interchange/collections/:collection/members/:object", async (req, reply) => {
      const { collection, object } = z
        .object({ collection: z.string().uuid(), object: z.string().uuid() })
        .parse(req.params);

      const col = await collectionAsRead(req, collection);
      if (!col) return reply.code(404).send({ ok: false, reports: ["collection.not-found"] });

      if (!(await hasMembership(collection, object))) {
        // Not a member, and the caller wanted it not to be. That is the state it
        // asked for, so it is a success that changed nothing.
        return { ok: true, fidelity: "full", reports: [], removed: false };
      }

      const gone = await app.inject({
        method: "DELETE",
        url: `${mount}/collections/${collection}/members/${object}`,
        headers: { authorization: req.headers.authorization ?? "" },
      });
      if (gone.statusCode >= 400) {
        return reply.code(gone.statusCode).send({ ok: false, reports: ["membership.refused"] });
      }
      return { ok: true, fidelity: "full", reports: [], removed: true };
    });

    /**
     * A collection's own keys.
     *
     * What this exists for is everything a collection carries that is not an
     * object and cannot be written any other way: a canvas's sticky notes and
     * the connections drawn between them, a table's columns, saved view state.
     * None of it is an object, and patching one was the only other write there
     * was.
     *
     * Only prefixed keys, which is one rule rather than a list of exceptions —
     * `kind`, `placement` and `members` are all unprefixed and each has rules a
     * generic bag cannot honour. Refused rather than ignored: a caller told its
     * write landed and then finding nothing changed cannot tell which happened.
     *
     * The prefix comes off on the way to storage. Hermes keeps its own keys
     * unprefixed in its own database — the prefix is the format's way of saying
     * whose they are on the wire, not a rename.
     */
    guarded.patch("/interchange/collections/:collection", async (req, reply) => {
      const { collection } = z.object({ collection: z.string().uuid() }).parse(req.params);
      const body = z
        .object({
          set: z.record(z.unknown()).optional(),
          unset: z.array(z.string()).optional(),
          version: z.number().int().optional(),
        })
        .parse(req.body);

      const col = await collectionAsRead(req, collection);
      if (!col) return reply.code(404).send({ ok: false, reports: ["collection.not-found"] });

      const decided = patchCollectionProps(col, body);
      if (!decided.ok) {
        return reply
          .code(decided.conflict ? 409 : 400)
          .send({ ok: false, ...(decided.conflict ? { conflict: true } : {}), reports: decided.reports });
      }

      // Ours only. A key under another producer's prefix travels and is stored
      // exactly as it arrived — that is the round-trip rule — but it is not one
      // of Hermes' properties and must not be unwrapped into one.
      const own = `${PRODUCER}:`;
      const strip = (k: string) => (k.startsWith(own) ? k.slice(own.length) : k);
      const set = Object.fromEntries(Object.entries(body.set ?? {}).map(([k, v]) => [strip(k), v]));
      const unset = (body.unset ?? []).map(strip);

      const wrote = await app.inject({
        method: "PATCH",
        url: `${mount}/collections/${collection}`,
        headers: { authorization: req.headers.authorization ?? "", "content-type": "application/json" },
        payload: { patch: { set, unset }, ...(body.version !== undefined ? { version: body.version } : {}) },
      });
      if (wrote.statusCode === 409) {
        return reply.code(409).send({ ok: false, conflict: true, reports: ["version.stale"] });
      }
      if (wrote.statusCode >= 400) {
        return reply.code(wrote.statusCode).send({ ok: false, reports: ["write.refused"] });
      }
      return { ok: true, fidelity: "full", reports: [] };
    });
  });
}
