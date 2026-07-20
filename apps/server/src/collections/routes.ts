import { and, asc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { generateKeyBetween } from "fractional-indexing";
import { z } from "zod";
import { collectionKindSchema } from "@hermes/shared";
import { blocks, blockTypes, memberships } from "@hermes/db";
import { db } from "../db.js";
import { sha256 } from "../lib/hash.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { authenticate, requireUser } from "../auth/middleware.js";
import { computeEmbedSource } from "../blocks/embed-source.js";

const ICON_BY_KIND: Record<string, string> = {
  document: "file-text",
  list: "list",
  table: "table",
  kanban: "kanban",
  matrix: "grid-3x3",
  masonry: "layout-grid",
  canvas: "layout-dashboard",
};

/** Embed a collection by its own title + description (design doc §4). */
function collectionEmbedSource(properties: Record<string, unknown>): string {
  return [properties.title, properties.description]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .join("\n");
}

const collectionView = {
  id: blocks.id,
  collectionKind: blocks.collectionKind,
  properties: blocks.properties,
  createdAt: blocks.createdAt,
  updatedAt: blocks.updatedAt,
  version: blocks.version,
};

export async function collectionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  // Top-level collections (not nested inside another collection).
  app.get("/collections", async (req) => {
    const userId = requireUser(req);
    return db
      .select(collectionView)
      .from(blocks)
      .where(
        and(
          eq(blocks.ownerId, userId),
          sql`${blocks.collectionKind} IS NOT NULL`,
          sql`NOT EXISTS (SELECT 1 FROM ${memberships} m WHERE m.block_id = ${blocks.id})`,
        ),
      )
      .orderBy(sql`${blocks.updatedAt} DESC`);
  });

  app.post("/collections", async (req, reply) => {
    const userId = requireUser(req);
    const body = z
      .object({
        kind: collectionKindSchema,
        title: z.string().default("Untitled"),
        description: z.string().optional(),
      })
      .parse(req.body);

    const properties: Record<string, unknown> = {
      title: body.title,
      description: body.description ?? "",
      membership_mode: "explicit",
      icon_key: ICON_BY_KIND[body.kind] ?? "folder",
      icon_color: "#5fa4b5",
    };
    if (body.kind === "list") {
      properties.list_format = "bullet";
      properties.sort_mode = "manual";
      properties.sync_checkbox_with_status = true;
    }

    const [row] = await db
      .insert(blocks)
      .values({
        ownerId: userId,
        blockTypeId: null,
        collectionKind: body.kind,
        properties,
        embedSource: collectionEmbedSource(properties),
        embedSourceHash: null,
      })
      .returning(collectionView);
    reply.code(201);
    return row;
  });

  // Collection + its ordered members.
  app.get("/collections/:id", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [collection] = await db
      .select(collectionView)
      .from(blocks)
      .where(and(eq(blocks.id, id), eq(blocks.ownerId, userId)))
      .limit(1);
    if (!collection || !collection.collectionKind) throw notFound("collection");

    const members = await db
      .select({
        membershipId: memberships.id,
        position: memberships.position,
        context: memberships.context,
        membershipVersion: memberships.version,
        id: blocks.id,
        blockTypeId: blocks.blockTypeId,
        collectionKind: blocks.collectionKind,
        content: blocks.content,
        properties: blocks.properties,
        version: blocks.version,
      })
      .from(memberships)
      .innerJoin(blocks, eq(blocks.id, memberships.blockId))
      .where(eq(memberships.collectionId, id))
      .orderBy(asc(memberships.position));

    return { collection, members };
  });

  app.patch("/collections/:id", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const patch = z.record(z.unknown()).parse(req.body);

    const [current] = await db
      .select({ properties: blocks.properties, collectionKind: blocks.collectionKind })
      .from(blocks)
      .where(and(eq(blocks.id, id), eq(blocks.ownerId, userId)))
      .limit(1);
    if (!current || !current.collectionKind) throw notFound("collection");

    const nextProps = { ...current.properties, ...patch };
    const embedSource = collectionEmbedSource(nextProps);
    const hash = sha256(embedSource);
    const [row] = await db
      .update(blocks)
      .set({
        properties: nextProps,
        embedSource,
        embedSourceHash: sql`CASE WHEN ${blocks.embedSourceHash} = ${hash} THEN ${blocks.embedSourceHash} ELSE NULL END`,
        version: sql`${blocks.version} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(blocks.id, id), eq(blocks.ownerId, userId)))
      .returning(collectionView);
    return row;
  });

  app.delete("/collections/:id", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    // Memberships cascade; members with no other parent return to the inbox.
    const res = await db
      .delete(blocks)
      .where(
        and(eq(blocks.id, id), eq(blocks.ownerId, userId), sql`${blocks.collectionKind} IS NOT NULL`),
      )
      .returning({ id: blocks.id });
    if (!res.length) throw notFound("collection");
    return { ok: true };
  });

  // ── Members ──────────────────────────────────────────────────
  async function lastPosition(collectionId: string): Promise<string | null> {
    const [row] = await db
      .select({ position: memberships.position })
      .from(memberships)
      .where(eq(memberships.collectionId, collectionId))
      .orderBy(sql`${memberships.position} DESC`)
      .limit(1);
    return row?.position ?? null;
  }

  async function assertCollection(userId: string, id: string) {
    const [c] = await db
      .select({ id: blocks.id })
      .from(blocks)
      .where(
        and(eq(blocks.id, id), eq(blocks.ownerId, userId), sql`${blocks.collectionKind} IS NOT NULL`),
      )
      .limit(1);
    if (!c) throw notFound("collection");
  }

  // Add a member: either an existing block, or create a new one in place.
  app.post("/collections/:id/members", async (req, reply) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await assertCollection(userId, id);
    const body = z
      .object({
        blockId: z.string().uuid().optional(),
        create: z
          .object({
            blockTypeId: z.string().uuid().optional(),
            content: z.string().optional(),
            properties: z.record(z.unknown()).optional(),
          })
          .optional(),
      })
      .parse(req.body);

    let blockId = body.blockId;
    if (!blockId) {
      // Create a new block (defaults to the text type).
      const c = body.create ?? {};
      const where = c.blockTypeId
        ? and(eq(blockTypes.id, c.blockTypeId), eq(blockTypes.ownerId, userId))
        : and(eq(blockTypes.ownerId, userId), eq(blockTypes.name, "text"));
      const [type] = await db.select().from(blockTypes).where(where).limit(1);
      if (!type) throw badRequest("unknown block type");
      const defaults: Record<string, unknown> = {};
      const schema = type.propertySchema;
      if (!type.isText && schema?.status_field && schema.default_value != null) {
        defaults[schema.status_field] = schema.default_value;
      }
      const content = type.isText ? c.content ?? "" : null;
      const properties = type.isText ? {} : { ...defaults, ...(c.properties ?? {}) };
      const embedSource = computeEmbedSource(type, { content, properties });
      const [b] = await db
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
        .returning({ id: blocks.id });
      blockId = b!.id;
    } else {
      const [b] = await db
        .select({ id: blocks.id })
        .from(blocks)
        .where(and(eq(blocks.id, blockId), eq(blocks.ownerId, userId)))
        .limit(1);
      if (!b) throw badRequest("unknown block");
    }

    const position = generateKeyBetween(await lastPosition(id), null);
    const [membership] = await db
      .insert(memberships)
      .values({ collectionId: id, blockId, position })
      .onConflictDoNothing()
      .returning({ id: memberships.id });
    if (!membership) throw conflict("block is already in this collection");
    reply.code(201);
    return { membershipId: membership.id, blockId, position };
  });

  app.delete("/collections/:id/members/:blockId", async (req) => {
    const userId = requireUser(req);
    const { id, blockId } = z
      .object({ id: z.string().uuid(), blockId: z.string().uuid() })
      .parse(req.params);
    await assertCollection(userId, id);
    await db
      .delete(memberships)
      .where(and(eq(memberships.collectionId, id), eq(memberships.blockId, blockId)));
    return { ok: true };
  });

  // Reorder (afterId/beforeId neighbors) and/or update membership context.
  app.patch("/collections/:id/members/:blockId", async (req) => {
    const userId = requireUser(req);
    const { id, blockId } = z
      .object({ id: z.string().uuid(), blockId: z.string().uuid() })
      .parse(req.params);
    await assertCollection(userId, id);
    const body = z
      .object({
        afterId: z.string().uuid().nullable().optional(),
        beforeId: z.string().uuid().nullable().optional(),
        context: z.record(z.unknown()).optional(),
      })
      .parse(req.body);

    const set: Record<string, unknown> = {};

    if (body.afterId !== undefined || body.beforeId !== undefined) {
      const posOf = async (bid: string | null | undefined): Promise<string | null> => {
        if (!bid) return null;
        const [m] = await db
          .select({ position: memberships.position })
          .from(memberships)
          .where(and(eq(memberships.collectionId, id), eq(memberships.blockId, bid)))
          .limit(1);
        return m?.position ?? null;
      };
      const after = await posOf(body.afterId);
      const before = await posOf(body.beforeId);
      set.position = generateKeyBetween(after, before);
    }

    if (body.context) {
      const [m] = await db
        .select({ context: memberships.context })
        .from(memberships)
        .where(and(eq(memberships.collectionId, id), eq(memberships.blockId, blockId)))
        .limit(1);
      set.context = { ...(m?.context ?? {}), ...body.context };
    }

    if (Object.keys(set).length === 0) return { ok: true };
    set.version = sql`${memberships.version} + 1`;
    await db
      .update(memberships)
      .set(set)
      .where(and(eq(memberships.collectionId, id), eq(memberships.blockId, blockId)));
    return { ok: true };
  });
}
