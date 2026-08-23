import { and, count, eq, sql } from "drizzle-orm";
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
  builtin: blockTypes.builtin,
  createdAt: blockTypes.createdAt,
  updatedAt: blockTypes.updatedAt,
};

// Design doc §3: every non-text block type must declare a `title` field.
function requireTitle(schema: PropertySchema) {
  if (!schema.fields.some((f) => f.key === "title")) {
    throw badRequest("non-text block types must include a 'title' field");
  }
}

/**
 * Locked (built-in core) fields can be edited but not removed. Ensure every
 * locked field in `current` is still present in `next`, and re-stamp the locked
 * flag so a client can't quietly unlock it.
 */
function preserveLocked(current: PropertySchema | null, next: PropertySchema): PropertySchema {
  const lockedKeys = (current?.fields ?? []).filter((f) => f.locked).map((f) => f.key);
  for (const key of lockedKeys) {
    if (!next.fields.some((f) => f.key === key)) {
      throw badRequest(`the '${key}' field is built-in and can't be removed`);
    }
  }
  const lockedSet = new Set(lockedKeys);
  return {
    ...next,
    fields: next.fields.map((f) => (lockedSet.has(f.key) ? { ...f, locked: true } : f)),
  };
}

export async function blockTypeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  app.get("/block-types", async (req) => {
    const userId = requireUser(req);
    return db
      .select({
        ...typeView,
        // NB: ${blockTypes.id} would render as unqualified "id", which inside
        // the subquery resolves to b.id — qualify the outer column explicitly.
        blockCount: sql<number>`(SELECT count(*)::int FROM ${blocks} b WHERE b.block_type_id = ${blockTypes}.id)`,
      })
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
    let embedShapeChanged = false;
    if (body.propertySchema !== undefined) {
      if (!current.isText) requireTitle(body.propertySchema);
      nextSchema = preserveLocked(current.propertySchema, body.propertySchema);
      schemaChanged = JSON.stringify(nextSchema) !== JSON.stringify(current.propertySchema);
      // What a block's embed_source is made of comes from `fields` and nothing
      // else — see deriveEmbedSource. The rest of a schema says what the type
      // *means*: which field carries completion, which profiles it declares. A
      // whole-object comparison read a profile declaration as a reason to
      // recompute and re-embed every block of the type, which is a lot of work
      // for a change that cannot alter a single embed_source.
      embedShapeChanged =
        JSON.stringify(nextSchema?.fields ?? null) !== JSON.stringify(current.propertySchema?.fields ?? null);
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
      // block of this type and mark it stale so the worker re-embeds. Gated on
      // the fields alone — nothing else in a schema can change what an
      // embed_source contains.
      if (embedShapeChanged) {
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
      .select({ isText: blockTypes.isText, builtin: blockTypes.builtin })
      .from(blockTypes)
      .where(and(eq(blockTypes.id, id), eq(blockTypes.ownerId, userId)))
      .limit(1);
    if (!t) throw notFound("block type");
    if (t.builtin || t.isText) throw conflict("built-in types can't be deleted");

    const [usage] = await db
      .select({ c: count() })
      .from(blocks)
      .where(eq(blocks.blockTypeId, id));
    if (Number(usage?.c ?? 0) > 0) throw conflict("type is in use by existing blocks");

    await db.delete(blockTypes).where(and(eq(blockTypes.id, id), eq(blockTypes.ownerId, userId)));
    return { ok: true };
  });
}
