import { blockTypes, blocks, changes, memberships, series } from "@hermes/db";
import { CONFORMANCE, narrow, toInterchange } from "@hermes/interchange";
import { and, eq, gt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, requireUser } from "../auth/middleware.js";
import { db } from "../db.js";

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
        })
        .from(blocks)
        .where(eq(blocks.ownerId, userId));

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
        })),
        memberships: mem.map((m) => ({
          collectionId: m.collectionId,
          blockId: m.blockId,
          position: m.position,
          context: (m.context ?? {}) as Record<string, unknown>,
        })),
        seriesRows,
        producer: { name: "hermes", version: "2.0.0" },
      });

      return { ...narrow(envelope, delta, q.profile), cursor, findings };
    });
  });
}
