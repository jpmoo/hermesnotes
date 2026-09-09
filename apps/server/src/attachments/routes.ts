import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash } from "node:crypto";
import { attachmentBlobs, attachments, blocks } from "@hermes/db";
import { db } from "../db.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { authenticate, requireUser } from "../auth/middleware.js";

const META = {
  id: attachments.id,
  blockId: attachments.blockId,
  filename: attachments.filename,
  mime: attachments.mime,
  size: attachments.size,
  /**
   * Which bytes this is.
   *
   * Handed to the client so a thumbnail can point at `/attachments/blob/:digest`
   * — which serves inline and is immutably cacheable — while the download button
   * keeps pointing at the attachment, which carries the name somebody gave it
   * and a `Content-Disposition` that saves rather than shows.
   *
   * That split is the difference between a thumbnail you can click to look at
   * and one that downloads a file every time you press it.
   */
  sha256: attachments.sha256,
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
      /*
       * The bytes go in once, under their own digest.
       *
       * Uploading a file this account already holds — the same attachment sent
       * to a second note, the same scan dropped twice — writes metadata and no
       * bytes at all. `ON CONFLICT DO NOTHING` is the whole of the check: two
       * uploads racing on one digest cannot both insert, and the loser does not
       * need to.
       */
      const digest = createHash("sha256").update(buf).digest("hex");
      await db
        .insert(attachmentBlobs)
        .values({ ownerId: userId, sha256: digest, size: buf.length, data: buf })
        .onConflictDoNothing();
      const [row] = await db
        .insert(attachments)
        .values({
          blockId: id,
          ownerId: userId,
          filename: part.filename || "file",
          mime: part.mimetype || "application/octet-stream",
          size: buf.length,
          sha256: digest,
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
   * **A move is a repointed row and a copy is a second row pointing at the same
   * bytes.** Neither duplicates a file: the bytes live in `attachment_blobs`
   * under their own digest, and an attachment is a name and a pointer. What
   * still differs between the two is history — a move leaves nothing behind,
   * a copy leaves the original where it was.
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
        sha256: attachments.sha256,
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
      // A second pointer at the same blob. Copying a fifty-megabyte PDF costs
      // a row; it used to cost fifty megabytes.
      [row] = await db
        .insert(attachments)
        .values({
          blockId,
          ownerId: userId,
          filename: source.filename,
          mime: source.mime,
          size: source.size,
          sha256: source.sha256,
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
    // The name is the attachment's and the bytes are the blob's. Joined rather
    // than looked up twice: two round trips to answer one download is a cost
    // paid on every thumbnail on the page.
    const [row] = await db
      .select({
        filename: attachments.filename,
        mime: attachments.mime,
        size: attachments.size,
        data: attachmentBlobs.data,
      })
      .from(attachments)
      .innerJoin(
        attachmentBlobs,
        and(
          eq(attachmentBlobs.ownerId, attachments.ownerId),
          eq(attachmentBlobs.sha256, attachments.sha256),
        ),
      )
      .where(and(eq(attachments.id, attId), eq(attachments.ownerId, userId)))
      .limit(1);
    if (!row) throw notFound("attachment");
    reply
      .header("Content-Type", row.mime)
      .header("Content-Disposition", `attachment; filename="${encodeURIComponent(row.filename)}"`)
      .header("Content-Length", String(row.size));
    return reply.send(row.data);
  });

  /**
   * Every distinct file this account holds.
   *
   * Not every attachment: the same PDF on four notes is one file and should
   * appear once in a picker, or choosing between four identical rows becomes
   * the person's problem. Keyed by digest, named after the most recent
   * attachment that used it — the name somebody last gave it is the one they
   * will recognize.
   *
   * `uses` is how many notes point at it, which is the one number that makes
   * the difference between "delete this" and "detach this" legible.
   */
  app.get("/attachments/library", async (req) => {
    const userId = requireUser(req);
    const rows = await db
      .select({
        sha256: attachments.sha256,
        filename: attachments.filename,
        mime: attachments.mime,
        size: attachments.size,
        createdAt: attachments.createdAt,
      })
      .from(attachments)
      .where(eq(attachments.ownerId, userId))
      .orderBy(desc(attachments.createdAt));

    const byDigest = new Map<
      string,
      { sha256: string; filename: string; mime: string; size: number; createdAt: Date; uses: number }
    >();
    for (const r of rows) {
      const seen = byDigest.get(r.sha256);
      // Ordered newest first, so the first sighting is the newest name.
      if (seen) seen.uses += 1;
      else byDigest.set(r.sha256, { ...r, uses: 1 });
    }
    return [...byDigest.values()];
  });

  /** A stored file's bytes, by digest — what a picker's thumbnails point at. */
  app.get("/attachments/blob/:digest", async (req, reply) => {
    const userId = requireUser(req);
    const { digest } = z.object({ digest: z.string().regex(/^[0-9a-f]{64}$/) }).parse(req.params);
    const [blob] = await db
      .select({ data: attachmentBlobs.data, size: attachmentBlobs.size })
      .from(attachmentBlobs)
      .where(and(eq(attachmentBlobs.ownerId, userId), eq(attachmentBlobs.sha256, digest)))
      .limit(1);
    if (!blob) throw notFound("file");
    // The mime belongs to an attachment rather than to the bytes, so the newest
    // name for this file decides how it is served. A picker asking for a
    // thumbnail wants the picture, not a download.
    const [named] = await db
      .select({ mime: attachments.mime })
      .from(attachments)
      .where(and(eq(attachments.ownerId, userId), eq(attachments.sha256, digest)))
      .orderBy(desc(attachments.createdAt))
      .limit(1);
    reply
      .header("Content-Type", named?.mime ?? "application/octet-stream")
      .header("Content-Length", String(blob.size))
      // Content-addressed: these bytes cannot change under this URL.
      .header("Cache-Control", "private, max-age=31536000, immutable");
    return reply.send(blob.data);
  });

  /**
   * Attach a file this account already holds — no upload.
   *
   * The other half of the answer to "how do I attach a file that already
   * exists". `place` moves or copies one attachment; this makes a new one from
   * a file in the library, which is what a picker needs.
   */
  app.post("/blocks/:id/attachments/existing", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { sha256, filename } = z
      .object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), filename: z.string().min(1).max(300).optional() })
      .parse(req.body);
    await ownedBlock(userId, id);

    const [blob] = await db
      .select({ size: attachmentBlobs.size })
      .from(attachmentBlobs)
      .where(and(eq(attachmentBlobs.ownerId, userId), eq(attachmentBlobs.sha256, sha256)))
      .limit(1);
    if (!blob) throw notFound("file");

    // Whatever it was last called, unless the caller says otherwise.
    const [named] = await db
      .select({ filename: attachments.filename, mime: attachments.mime })
      .from(attachments)
      .where(and(eq(attachments.ownerId, userId), eq(attachments.sha256, sha256)))
      .orderBy(desc(attachments.createdAt))
      .limit(1);

    const [row] = await db
      .insert(attachments)
      .values({
        blockId: id,
        ownerId: userId,
        filename: filename ?? named?.filename ?? "file",
        mime: named?.mime ?? "application/octet-stream",
        size: blob.size,
        sha256,
      })
      .returning(META);
    await db.update(blocks).set({ updatedAt: new Date() }).where(eq(blocks.id, id));
    return row;
  });

  /**
   * Files nothing points at, and what they cost.
   *
   * A blob outlives its attachments only if something goes wrong: deleting the
   * last attachment for a file collects its blob in the same request. But that
   * is one code path holding a promise about disk, and a promise about disk is
   * exactly the kind that fails quietly — an interrupted request, a delete that
   * raced with a copy, a row removed by a cascade that never ran this code at
   * all. Blocks cascade to attachments, and an attachment removed that way
   * never reaches the delete route.
   *
   * So: a way to ask, and a way to sweep. Reading is free and says how much is
   * at stake; sweeping is a button, because "nothing points at this" is a
   * statement about a moment and somebody should be the one choosing it.
   */
  app.get("/attachments/orphans", async (req) => {
    const userId = requireUser(req);
    const rows = await db
      .select({ sha256: attachmentBlobs.sha256, size: attachmentBlobs.size })
      .from(attachmentBlobs)
      .where(
        and(
          eq(attachmentBlobs.ownerId, userId),
          sql`NOT EXISTS (
            SELECT 1 FROM ${attachments} a
            WHERE a.owner_id = ${attachmentBlobs.ownerId} AND a.sha256 = ${attachmentBlobs.sha256}
          )`,
        ),
      );
    // What sharing actually saved, said in the same breath — the number that
    // makes the feature legible is not the leak but the saving.
    const [held = { files: 0, blobs: 0, stored: 0, named: 0 }] = await db
      .select({
        files: sql<number>`count(*)::int`,
        blobs: sql<number>`count(distinct ${attachments.sha256})::int`,
        named: sql<number>`coalesce(sum(${attachments.size}), 0)::bigint`,
        stored: sql<number>`0::bigint`,
      })
      .from(attachments)
      .where(eq(attachments.ownerId, userId));
    const [{ stored } = { stored: 0 }] = await db
      .select({ stored: sql<number>`coalesce(sum(${attachmentBlobs.size}), 0)::bigint` })
      .from(attachmentBlobs)
      .where(eq(attachmentBlobs.ownerId, userId));
    return {
      orphans: rows.length,
      wasted: rows.reduce((n, r) => n + r.size, 0),
      files: held.files,
      blobs: held.blobs,
      named: Number(held.named),
      stored: Number(stored),
    };
  });

  app.post("/attachments/orphans/sweep", async (req) => {
    const userId = requireUser(req);
    // The same rule the tag sweep follows: a hard delete is a browser session's
    // to ask for, not an API key's.
    if (req.authKind !== "cookie") throw forbidden("hard delete requires a browser session");
    const gone = await db
      .delete(attachmentBlobs)
      .where(
        and(
          eq(attachmentBlobs.ownerId, userId),
          sql`NOT EXISTS (
            SELECT 1 FROM ${attachments} a
            WHERE a.owner_id = ${attachmentBlobs.ownerId} AND a.sha256 = ${attachmentBlobs.sha256}
          )`,
        ),
      )
      .returning({ sha256: attachmentBlobs.sha256, size: attachmentBlobs.size });
    return { deleted: gone.length, freed: gone.reduce((n, r) => n + r.size, 0) };
  });

  /** Delete an attachment (removes the file from the server). */
  app.delete("/attachments/:attId", async (req) => {
    const userId = requireUser(req);
    const { attId } = z.object({ attId: z.string().uuid() }).parse(req.params);
    const res = await db
      .delete(attachments)
      .where(and(eq(attachments.id, attId), eq(attachments.ownerId, userId)))
      .returning({ id: attachments.id, sha256: attachments.sha256 });
    if (!res.length) throw notFound("attachment");

    /*
     * And the bytes, if that was the last thing pointing at them.
     *
     * Without this, deleting every attachment for a file would leave the file
     * itself in the database forever — the storage saving of sharing blobs
     * turned into a leak by the one operation meant to reclaim space. A blob
     * still referenced is left alone, which is the whole point of it being
     * shared.
     */
    const digest = res[0]!.sha256;
    const [{ count } = { count: 0 }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(attachments)
      .where(and(eq(attachments.ownerId, userId), eq(attachments.sha256, digest)));
    if (count === 0) {
      await db
        .delete(attachmentBlobs)
        .where(and(eq(attachmentBlobs.ownerId, userId), eq(attachmentBlobs.sha256, digest)));
    }
    return { ok: true };
  });
}
