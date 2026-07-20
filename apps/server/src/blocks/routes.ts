import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { blocks, blockTypes, memberships } from "@hermes/db";
import { db } from "../db.js";
import { sha256 } from "../lib/hash.js";
import { htmlToText } from "../lib/htmltext.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { authenticate, requireUser } from "../auth/middleware.js";

/** Resolve this user's `text` block type id (seeded at signup). */
async function textTypeId(ownerId: string): Promise<string> {
  const [row] = await db
    .select({ id: blockTypes.id })
    .from(blockTypes)
    .where(and(eq(blockTypes.ownerId, ownerId), eq(blockTypes.name, "text")))
    .limit(1);
  if (!row) throw badRequest("text block type missing for user");
  return row.id;
}

const blockView = {
  id: blocks.id,
  blockTypeId: blocks.blockTypeId,
  collectionKind: blocks.collectionKind,
  content: blocks.content,
  properties: blocks.properties,
  embeddedAt: blocks.embeddedAt,
  embedPending: sql<boolean>`(${blocks.embedSourceHash} IS NULL AND ${blocks.embedSource} IS NOT NULL)`,
  version: blocks.version,
  createdAt: blocks.createdAt,
  updatedAt: blocks.updatedAt,
};

export async function blockRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  // Create a text block (Phase 1). embed_source = content; left stale for the worker.
  app.post("/blocks", async (req, reply) => {
    const userId = requireUser(req);
    const { content } = z.object({ content: z.string().default("") }).parse(req.body);
    const typeId = await textTypeId(userId);
    const embedSource = htmlToText(content); // text blocks embed stripped plain text
    const [row] = await db
      .insert(blocks)
      .values({
        ownerId: userId,
        blockTypeId: typeId,
        content,
        embedSource,
        embedSourceHash: null, // stale → embedding worker will fill
      })
      .returning(blockView);
    reply.code(201);
    return row;
  });

  /**
   * Inbox (design doc §9): blocks with no parent AND no children. Pure query,
   * scoped to the owner. Collections (collection_kind set) are exempted so an
   * empty board doesn't masquerade as an inbox item (doc §9 open item #1 → exempt).
   */
  app.get("/blocks/inbox", async (req) => {
    const userId = requireUser(req);
    return db
      .select(blockView)
      .from(blocks)
      .where(
        and(
          eq(blocks.ownerId, userId),
          sql`${blocks.collectionKind} IS NULL`,
          sql`NOT EXISTS (SELECT 1 FROM ${memberships} m WHERE m.block_id = ${blocks.id})`,
          sql`NOT EXISTS (SELECT 1 FROM ${memberships} m WHERE m.collection_id = ${blocks.id})`,
        ),
      )
      .orderBy(desc(blocks.updatedAt));
  });

  app.get("/blocks/:id", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [row] = await db
      .select(blockView)
      .from(blocks)
      .where(and(eq(blocks.id, id), eq(blocks.ownerId, userId)))
      .limit(1);
    if (!row) throw notFound("block");
    return row;
  });

  // Update text content with optimistic concurrency (doc §11).
  app.patch("/blocks/:id", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { content, version } = z
      .object({ content: z.string(), version: z.number().int() })
      .parse(req.body);

    const embedSource = htmlToText(content);
    const hash = sha256(embedSource);
    // Only re-stale the embedding when the embedded (plain-text) content changed.
    const [updated] = await db
      .update(blocks)
      .set({
        content,
        embedSource,
        embedSourceHash: sql`CASE WHEN ${blocks.embedSourceHash} = ${hash} THEN ${blocks.embedSourceHash} ELSE NULL END`,
        version: sql`${blocks.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(eq(blocks.id, id), eq(blocks.ownerId, userId), eq(blocks.version, version)),
      )
      .returning(blockView);

    if (!updated) {
      // Distinguish "not found" from "version conflict".
      const [exists] = await db
        .select({ id: blocks.id })
        .from(blocks)
        .where(and(eq(blocks.id, id), eq(blocks.ownerId, userId)))
        .limit(1);
      if (!exists) throw notFound("block");
      throw conflict("version conflict — reload and retry");
    }
    return updated;
  });

  app.delete("/blocks/:id", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const res = await db
      .delete(blocks)
      .where(and(eq(blocks.id, id), eq(blocks.ownerId, userId)))
      .returning({ id: blocks.id });
    if (!res.length) throw notFound("block");
    return { ok: true };
  });
}
