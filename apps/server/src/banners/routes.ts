import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { banners } from "@hermes/db";
import { db } from "../db.js";
import { badRequest, notFound } from "../lib/errors.js";
import { authenticate, requireUser } from "../auth/middleware.js";

const OK_MIME = new Set(["image/png", "image/jpeg", "image/gif"]);

/**
 * Standalone banner images: uploaded on their own (not attachments), then a
 * block/collection's properties.banner or a UI preference references the id.
 * Served with cookie auth so an <img> can load them.
 */
export async function bannerRoutes(app: FastifyInstance): Promise<void> {
  app.post("/banners", { preHandler: authenticate }, async (req) => {
    const userId = requireUser(req);
    if (!req.isMultipart()) throw badRequest("expected multipart/form-data");
    const part = await req.file();
    if (!part) throw badRequest("no file uploaded");
    const mime = part.mimetype || "application/octet-stream";
    if (!OK_MIME.has(mime)) throw badRequest("banner must be PNG, JPG, or GIF");
    const buf = await part.toBuffer();
    if (buf.length > 15 * 1024 * 1024) throw badRequest("banner too large (max 15 MB)");
    const [row] = await db
      .insert(banners)
      .values({ ownerId: userId, mime, size: buf.length, data: buf })
      .returning({ id: banners.id });
    return { id: row!.id };
  });

  /**
   * The account's uploaded banners, newest first — metadata only, so the picker
   * can show a gallery and reuse an image instead of uploading it again. The
   * bytes come from /banners/:id per thumbnail.
   */
  app.get("/banners", { preHandler: authenticate }, async (req) => {
    const userId = requireUser(req);
    return db
      .select({ id: banners.id, mime: banners.mime, size: banners.size, createdAt: banners.createdAt })
      .from(banners)
      .where(eq(banners.ownerId, userId))
      .orderBy(desc(banners.createdAt))
      .limit(200);
  });

  app.get("/banners/:id", { preHandler: authenticate }, async (req, reply) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [row] = await db
      .select()
      .from(banners)
      .where(and(eq(banners.id, id), eq(banners.ownerId, userId)))
      .limit(1);
    if (!row) throw notFound("banner");
    return reply
      .header("Content-Type", row.mime)
      .header("Cache-Control", "private, max-age=86400")
      .header("Content-Length", String(row.size))
      .send(row.data);
  });
}
