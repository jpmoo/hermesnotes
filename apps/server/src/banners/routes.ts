import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { periodicKindOf } from "@hermes/shared";
import { banners, blocks, userSettings } from "@hermes/db";
import { db } from "../db.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { authenticate, requireUser } from "../auth/middleware.js";

/** Landing pages that can carry a banner, and how to name them to a reader. */
const PAGE_LABELS: Record<string, string> = {
  today: "Today",
  favorites: "Favorites",
  blocks: "All blocks",
  collections: "Collections",
  types: "Types",
  review: "Weekly review",
  archive: "Archive",
  settings: "Settings",
};

/** How a block referencing a banner should be described in the gallery. */
function usageLabel(row: {
  properties: unknown;
  collectionKind: string | null;
  archivedAt: Date | null;
}): string {
  const props = (row.properties ?? {}) as Record<string, unknown>;
  // Archived blocks still hold their banner, so they count as a use — worth
  // saying which ones they are, since deleting the image reaches into the
  // Archive too and those aren't in front of you.
  const suffix = row.archivedAt ? " (archived)" : "";
  const periodic = periodicKindOf(props);
  if (periodic) return `${periodic.kind.describe(periodic.period)}${suffix}`;
  const title = typeof props.title === "string" && props.title.trim() ? props.title : "Untitled";
  return row.collectionKind ? `${title} (collection)${suffix}` : `${title}${suffix}`;
}

/**
 * Everywhere each of this account's banners is currently used: blocks and
 * collections that reference it (daily notes and weekly reflections named as
 * such), landing pages, and the page-background fallback.
 */
async function usageByBanner(userId: string): Promise<Map<string, string[]>> {
  const used = new Map<string, string[]>();
  const add = (id: string, label: string) => {
    const list = used.get(id);
    if (list) list.push(label);
    else used.set(id, [label]);
  };

  const rows = await db
    .select({
      bannerId: sql<string>`${blocks.properties} -> 'banner' ->> 'id'`,
      properties: blocks.properties,
      collectionKind: blocks.collectionKind,
      // Deliberately unfiltered by archivedAt: an archived note keeps its banner,
      // so it's a real use and the label marks it as archived.
      archivedAt: blocks.archivedAt,
    })
    .from(blocks)
    .where(
      and(
        eq(blocks.ownerId, userId),
        sql`${blocks.properties} -> 'banner' ->> 'id' IS NOT NULL`,
      ),
    );
  for (const row of rows) if (row.bannerId) add(row.bannerId, usageLabel(row));

  const [settings] = await db
    .select({ preferences: userSettings.preferences })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  const prefs = (settings?.preferences ?? {}) as Record<string, unknown>;
  const pageBanners = (prefs.banners ?? {}) as Record<string, { id?: string } | null>;
  for (const [key, value] of Object.entries(pageBanners)) {
    if (value?.id) add(value.id, `${PAGE_LABELS[key] ?? key} page`);
  }
  const fallback = prefs.bg_fallback as { id?: string } | null | undefined;
  if (fallback?.id) add(fallback.id, "Page background");

  return used;
}

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
    const rows = await db
      .select({ id: banners.id, mime: banners.mime, size: banners.size, createdAt: banners.createdAt })
      .from(banners)
      .where(eq(banners.ownerId, userId))
      .orderBy(desc(banners.createdAt))
      .limit(200);
    const used = await usageByBanner(userId);
    return rows.map((r) => ({ ...r, usedBy: used.get(r.id) ?? [] }));
  });

  /**
   * Delete a banner and every reference to it. Deliberately not a soft delete:
   * the image is the thing being discarded, so the blocks, pages and background
   * that pointed at it are cleared in the same transaction rather than left
   * pointing at nothing.
   */
  app.delete("/banners/:id", { preHandler: authenticate }, async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    // Destroying an image is browser-session-only, as with a block hard delete:
    // an access key (so, an AI agent) must not be able to erase artwork.
    if (req.authKind !== "cookie") throw forbidden("deleting an image requires a browser session");

    await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: banners.id })
        .from(banners)
        .where(and(eq(banners.id, id), eq(banners.ownerId, userId)))
        .limit(1);
      if (!row) throw notFound("banner");

      // Blocks and collections carrying it.
      await tx
        .update(blocks)
        .set({
          properties: sql`${blocks.properties} - 'banner'`,
          version: sql`${blocks.version} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(blocks.ownerId, userId),
            sql`${blocks.properties} -> 'banner' ->> 'id' = ${id}`,
          ),
        );

      // Landing pages and the background fallback.
      const [settings] = await tx
        .select({ preferences: userSettings.preferences })
        .from(userSettings)
        .where(eq(userSettings.userId, userId))
        .limit(1);
      const prefs = { ...((settings?.preferences ?? {}) as Record<string, unknown>) };
      const pageBanners = { ...((prefs.banners ?? {}) as Record<string, { id?: string } | null>) };
      let touched = false;
      for (const [key, value] of Object.entries(pageBanners)) {
        if (value?.id === id) {
          delete pageBanners[key];
          touched = true;
        }
      }
      if ((prefs.bg_fallback as { id?: string } | null | undefined)?.id === id) {
        delete prefs.bg_fallback;
        touched = true;
      }
      if (touched) {
        prefs.banners = pageBanners;
        await tx
          .update(userSettings)
          .set({ preferences: prefs, updatedAt: new Date() })
          .where(eq(userSettings.userId, userId));
      }

      await tx.delete(banners).where(and(eq(banners.id, id), eq(banners.ownerId, userId)));
    });
    return { ok: true };
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
