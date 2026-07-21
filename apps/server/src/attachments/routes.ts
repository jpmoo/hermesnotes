import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { attachments, blocks } from "@hermes/db";
import { db } from "../db.js";
import { badRequest, notFound } from "../lib/errors.js";
import { authenticate, requireUser } from "../auth/middleware.js";

const META = {
  id: attachments.id,
  blockId: attachments.blockId,
  filename: attachments.filename,
  mime: attachments.mime,
  size: attachments.size,
  createdAt: attachments.createdAt,
};

/** Confirm the block exists and belongs to the user. */
async function ownedBlock(userId: string, blockId: string) {
  const [b] = await db
    .select({ id: blocks.id })
    .from(blocks)
    .where(and(eq(blocks.id, blockId), eq(blocks.ownerId, userId)))
    .limit(1);
  if (!b) throw notFound("block");
  return b;
}

export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  /** List a block's attachments (metadata only). */
  app.get("/blocks/:id/attachments", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await ownedBlock(userId, id);
    return db
      .select(META)
      .from(attachments)
      .where(eq(attachments.blockId, id))
      .orderBy(asc(attachments.createdAt));
  });

  /** Upload one or more files (multipart) against a block. */
  app.post("/blocks/:id/attachments", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await ownedBlock(userId, id);
    if (!req.isMultipart()) throw badRequest("expected multipart/form-data");

    const saved: unknown[] = [];
    for await (const part of req.files()) {
      const buf = await part.toBuffer();
      const [row] = await db
        .insert(attachments)
        .values({
          blockId: id,
          ownerId: userId,
          filename: part.filename || "file",
          mime: part.mimetype || "application/octet-stream",
          size: buf.length,
          data: buf,
        })
        .returning(META);
      saved.push(row);
    }
    if (saved.length === 0) throw badRequest("no files uploaded");
    // Uploading counts as touching the block.
    await db.update(blocks).set({ updatedAt: new Date() }).where(eq(blocks.id, id));
    return saved;
  });

  /** Download an attachment's bytes. */
  app.get("/attachments/:attId", async (req, reply) => {
    const userId = requireUser(req);
    const { attId } = z.object({ attId: z.string().uuid() }).parse(req.params);
    const [row] = await db
      .select()
      .from(attachments)
      .where(and(eq(attachments.id, attId), eq(attachments.ownerId, userId)))
      .limit(1);
    if (!row) throw notFound("attachment");
    reply
      .header("Content-Type", row.mime)
      .header("Content-Disposition", `attachment; filename="${encodeURIComponent(row.filename)}"`)
      .header("Content-Length", String(row.size));
    return reply.send(row.data);
  });

  /** Delete an attachment (removes the file from the server). */
  app.delete("/attachments/:attId", async (req) => {
    const userId = requireUser(req);
    const { attId } = z.object({ attId: z.string().uuid() }).parse(req.params);
    const res = await db
      .delete(attachments)
      .where(and(eq(attachments.id, attId), eq(attachments.ownerId, userId)))
      .returning({ id: attachments.id });
    if (!res.length) throw notFound("attachment");
    return { ok: true };
  });
}
