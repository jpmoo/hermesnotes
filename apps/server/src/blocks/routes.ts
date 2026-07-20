import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { blocks, blockTypes, memberships } from "@hermes/db";
import { db } from "../db.js";
import { sha256 } from "../lib/hash.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { authenticate, requireUser } from "../auth/middleware.js";
import { computeEmbedSource } from "./embed-source.js";

/** Resolve a block type for this owner, defaulting to the seeded `text` type. */
async function resolveType(ownerId: string, blockTypeId?: string) {
  const where = blockTypeId
    ? and(eq(blockTypes.id, blockTypeId), eq(blockTypes.ownerId, ownerId))
    : and(eq(blockTypes.ownerId, ownerId), eq(blockTypes.name, "text"));
  const [row] = await db.select().from(blockTypes).where(where).limit(1);
  if (!row) throw badRequest(blockTypeId ? "unknown block type" : "text block type missing");
  return row;
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

  // Create a block of any type. Text types embed content; typed blocks derive
  // embed_source from their properties. Left stale for the embedding worker.
  app.post("/blocks", async (req, reply) => {
    const userId = requireUser(req);
    const body = z
      .object({
        blockTypeId: z.string().uuid().optional(),
        content: z.string().optional(),
        properties: z.record(z.unknown()).optional(),
      })
      .parse(req.body);

    const type = await resolveType(userId, body.blockTypeId);
    const content = type.isText ? body.content ?? "" : null;
    const properties = type.isText ? {} : body.properties ?? {};
    const embedSource = computeEmbedSource(type, { content, properties });

    const [row] = await db
      .insert(blocks)
      .values({
        ownerId: userId,
        blockTypeId: type.id,
        content,
        properties,
        embedSource,
        embedSourceHash: null,
        blockTypeSchemaVersion: type.schemaVersion,
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

  // Update a block (content for text, properties for typed) with optimistic
  // concurrency (doc §11).
  app.patch("/blocks/:id", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        content: z.string().optional(),
        properties: z.record(z.unknown()).optional(),
        version: z.number().int(),
      })
      .parse(req.body);

    const [current] = await db
      .select({
        content: blocks.content,
        properties: blocks.properties,
        blockTypeId: blocks.blockTypeId,
      })
      .from(blocks)
      .where(and(eq(blocks.id, id), eq(blocks.ownerId, userId)))
      .limit(1);
    if (!current) throw notFound("block");

    const type = await resolveType(userId, current.blockTypeId);
    const nextContent = type.isText ? body.content ?? current.content ?? "" : current.content;
    const nextProps = type.isText ? current.properties : body.properties ?? current.properties;
    const embedSource = computeEmbedSource(type, { content: nextContent, properties: nextProps });
    const hash = sha256(embedSource);

    const [updated] = await db
      .update(blocks)
      .set({
        content: nextContent,
        properties: nextProps,
        embedSource,
        embedSourceHash: sql`CASE WHEN ${blocks.embedSourceHash} = ${hash} THEN ${blocks.embedSourceHash} ELSE NULL END`,
        version: sql`${blocks.version} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(blocks.id, id), eq(blocks.ownerId, userId), eq(blocks.version, body.version)))
      .returning(blockView);

    if (!updated) throw conflict("version conflict — reload and retry");
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
