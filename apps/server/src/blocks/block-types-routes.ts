import { and, count, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { propertySchemaSchema, type PropertySchema } from "@hermes/shared";
import { blocks, blockTypes } from "@hermes/db";
import { db } from "../db.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { authenticate, requireUser } from "../auth/middleware.js";
import { computeEmbedSource } from "./embed-source.js";

const typeView = {
  id: blockTypes.id,
  name: blockTypes.name,
  iconKey: blockTypes.iconKey,
  iconColor: blockTypes.iconColor,
  iconSource: blockTypes.iconSource,
  showIcon: blockTypes.showIcon,
  propertySchema: blockTypes.propertySchema,
  schemaVersion: blockTypes.schemaVersion,
  isText: blockTypes.isText,
  createdAt: blockTypes.createdAt,
  updatedAt: blockTypes.updatedAt,
};

// Design doc §3: every non-text block type must declare a `title` field.
function requireTitle(schema: PropertySchema) {
  if (!schema.fields.some((f) => f.key === "title")) {
    throw badRequest("non-text block types must include a 'title' field");
  }
}

export async function blockTypeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  app.get("/block-types", async (req) => {
    const userId = requireUser(req);
    return db
      .select(typeView)
      .from(blockTypes)
      .where(eq(blockTypes.ownerId, userId))
      .orderBy(blockTypes.name);
  });

  app.post("/block-types", async (req, reply) => {
    const userId = requireUser(req);
    const body = z
      .object({
        name: z.string().min(1),
        iconKey: z.string().nullable().optional(),
        iconColor: z.string().nullable().optional(),
        showIcon: z.boolean().optional(),
        propertySchema: propertySchemaSchema,
      })
      .parse(req.body);
    requireTitle(body.propertySchema);

    const existing = await db
      .select({ id: blockTypes.id })
      .from(blockTypes)
      .where(and(eq(blockTypes.ownerId, userId), eq(blockTypes.name, body.name)))
      .limit(1);
    if (existing.length) throw conflict("a block type with that name already exists");

    const [row] = await db
      .insert(blockTypes)
      .values({
        ownerId: userId,
        name: body.name,
        isText: false,
        iconKey: body.iconKey ?? null,
        iconColor: body.iconColor ?? null,
        showIcon: body.showIcon ?? true,
        propertySchema: body.propertySchema,
      })
      .returning(typeView);
    reply.code(201);
    return row;
  });

  app.patch("/block-types/:id", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        name: z.string().min(1).optional(),
        iconKey: z.string().nullable().optional(),
        iconColor: z.string().nullable().optional(),
        showIcon: z.boolean().optional(),
        propertySchema: propertySchemaSchema.optional(),
      })
      .parse(req.body);

    const [current] = await db
      .select()
      .from(blockTypes)
      .where(and(eq(blockTypes.id, id), eq(blockTypes.ownerId, userId)))
      .limit(1);
    if (!current) throw notFound("block type");

    let nextSchema = current.propertySchema;
    let schemaChanged = false;
    if (body.propertySchema !== undefined && !current.isText) {
      requireTitle(body.propertySchema);
      nextSchema = body.propertySchema;
      schemaChanged =
        JSON.stringify(body.propertySchema) !== JSON.stringify(current.propertySchema);
    }
    const nextVersion = schemaChanged ? current.schemaVersion + 1 : current.schemaVersion;

    await db.transaction(async (tx) => {
      await tx
        .update(blockTypes)
        .set({
          name: body.name ?? current.name,
          iconKey: body.iconKey !== undefined ? body.iconKey : current.iconKey,
          iconColor: body.iconColor !== undefined ? body.iconColor : current.iconColor,
          showIcon: body.showIcon ?? current.showIcon,
          propertySchema: nextSchema,
          schemaVersion: nextVersion,
          updatedAt: new Date(),
        })
        .where(eq(blockTypes.id, id));

      // Schema-change cascade (design doc §4): recompute embed_source for every
      // block of this type and mark it stale so the worker re-embeds.
      if (schemaChanged) {
        const rows = await tx
          .select({ id: blocks.id, content: blocks.content, properties: blocks.properties })
          .from(blocks)
          .where(and(eq(blocks.blockTypeId, id), eq(blocks.ownerId, userId)));
        for (const b of rows) {
          const embedSource = computeEmbedSource(
            { isText: current.isText, propertySchema: nextSchema },
            { content: b.content, properties: b.properties },
          );
          await tx
            .update(blocks)
            .set({
              embedSource,
              embedSourceHash: null,
              embeddedAt: null,
              blockTypeSchemaVersion: nextVersion,
            })
            .where(eq(blocks.id, b.id));
        }
      }
    });

    const [updated] = await db.select(typeView).from(blockTypes).where(eq(blockTypes.id, id)).limit(1);
    return updated;
  });

  app.delete("/block-types/:id", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [t] = await db
      .select({ isText: blockTypes.isText })
      .from(blockTypes)
      .where(and(eq(blockTypes.id, id), eq(blockTypes.ownerId, userId)))
      .limit(1);
    if (!t) throw notFound("block type");
    if (t.isText) throw conflict("the text type cannot be deleted");

    const [usage] = await db
      .select({ c: count() })
      .from(blocks)
      .where(eq(blocks.blockTypeId, id));
    if (Number(usage?.c ?? 0) > 0) throw conflict("type is in use by existing blocks");

    await db.delete(blockTypes).where(and(eq(blockTypes.id, id), eq(blockTypes.ownerId, userId)));
    return { ok: true };
  });
}
