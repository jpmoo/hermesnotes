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

  /**
   * The same file, on a different block — moved or copied.
   *
   * The answer to "how do I attach a file that is already here without
   * uploading it again". Every other route in this file takes bytes over the
   * wire; this one takes an id, because the bytes are already in the database
   * and sending a person's own file back to them so they can send it forwards
   * is work nobody needed doing.
   *
   * **A move is a repointed row and a copy is a second one.** The rows carry
   * their own bytes, so a copy genuinely duplicates them — there is no shared
   * blob store behind this and no content hash to key one on. That is the
   * honest cost and it is why move exists beside copy rather than copy alone:
   * moving a fifty-megabyte PDF to the right note should not double it.
   */
  app.post("/attachments/:attId/place", async (req) => {
    const userId = requireUser(req);
    const { attId } = z.object({ attId: z.string().uuid() }).parse(req.params);
    const { blockId, mode } = z
      .object({ blockId: z.string().uuid(), mode: z.enum(["move", "copy"]) })
      .parse(req.body);

    // Both ends owned by the asker, checked before anything is written. An
    // attachment id is a uuid somebody could have from anywhere.
    await ownedBlock(userId, blockId);
    const [source] = await db
      .select({
        id: attachments.id,
        blockId: attachments.blockId,
        filename: attachments.filename,
        mime: attachments.mime,
        size: attachments.size,
        data: attachments.data,
      })
      .from(attachments)
      .where(and(eq(attachments.id, attId), eq(attachments.ownerId, userId)))
      .limit(1);
    if (!source) throw notFound("attachment");

    // Already there. Not an error — somebody picked the note it is on, which is
    // an ordinary thing to do by accident — and not a duplicate either: a copy
    // onto its own block would leave two identical files with no way to tell
    // which was meant.
    if (source.blockId === blockId) {
      const [same] = await db.select(META).from(attachments).where(eq(attachments.id, attId));
      return { ...same, unchanged: true };
    }

    const touched = [blockId, source.blockId];
    let row;
    if (mode === "move") {
      [row] = await db
        .update(attachments)
        .set({ blockId })
        .where(and(eq(attachments.id, attId), eq(attachments.ownerId, userId)))
        .returning(META);
    } else {
      [row] = await db
        .insert(attachments)
        .values({
          blockId,
          ownerId: userId,
          filename: source.filename,
          mime: source.mime,
          size: source.size,
          data: source.data,
        })
        .returning(META);
    }

    // Both ends were touched: one gained a file and, on a move, one lost it.
    for (const id of mode === "move" ? touched : [blockId]) {
      await db.update(blocks).set({ updatedAt: new Date() }).where(eq(blocks.id, id));
    }
    return row;
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
