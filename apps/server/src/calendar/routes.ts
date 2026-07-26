import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { blockTypes, blocks, calendarConverted, calendarFeeds } from "@hermes/db";
import { db } from "../db.js";
import { badRequest, notFound } from "../lib/errors.js";
import { authenticate, requireUser } from "../auth/middleware.js";
import { computeEmbedSource } from "../blocks/embed-source.js";
import { eventsInRange, type ParsedEvent } from "./ical.js";

/** In-memory raw-ICS cache, keyed by feed id. Refetched past the TTL. */
const CACHE = new Map<string, { fetchedAt: number; text: string }>();
const TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;

async function fetchIcs(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // Some providers publish webcal:// URLs — same content over https.
    const httpUrl = url.replace(/^webcal:\/\//i, "https://");
    const res = await fetch(httpUrl, {
      signal: controller.signal,
      headers: { "User-Agent": "HermesNotes/1.0", Accept: "text/calendar, text/plain, */*" },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`feed responded ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Get a feed's ICS text (cached), refetching past the TTL or when forced. */
async function icsFor(feed: { id: string; url: string }, force: boolean): Promise<string> {
  const hit = CACHE.get(feed.id);
  if (!force && hit && Date.now() - hit.fetchedAt < TTL_MS) return hit.text;
  const text = await fetchIcs(feed.url);
  CACHE.set(feed.id, { fetchedAt: Date.now(), text });
  return text;
}

const feedView = {
  id: calendarFeeds.id,
  name: calendarFeeds.name,
  url: calendarFeeds.url,
  color: calendarFeeds.color,
  enabled: calendarFeeds.enabled,
  lastFetchedAt: calendarFeeds.lastFetchedAt,
  lastError: calendarFeeds.lastError,
  sort: calendarFeeds.sort,
};

export async function calendarRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  /** List the user's calendar feeds. */
  app.get("/calendar/feeds", async (req) => {
    const userId = requireUser(req);
    return db
      .select(feedView)
      .from(calendarFeeds)
      .where(eq(calendarFeeds.ownerId, userId))
      .orderBy(asc(calendarFeeds.sort), asc(calendarFeeds.createdAt));
  });

  /** Add a calendar subscription. */
  app.post("/calendar/feeds", async (req, reply) => {
    const userId = requireUser(req);
    const body = z
      .object({
        name: z.string().trim().min(1).max(200),
        url: z.string().trim().min(1).max(2000),
        color: z.string().trim().max(32).optional(),
      })
      .parse(req.body);
    const [row] = await db
      .insert(calendarFeeds)
      .values({ ownerId: userId, name: body.name, url: body.url, color: body.color ?? "#6b7cff" })
      .returning(feedView);
    reply.code(201);
    return row;
  });

  /** Update a feed (name / url / color / enabled). Clears the cache on url change. */
  app.patch("/calendar/feeds/:id", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        name: z.string().trim().min(1).max(200).optional(),
        url: z.string().trim().min(1).max(2000).optional(),
        color: z.string().trim().max(32).optional(),
        enabled: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.url !== undefined) patch.url = body.url;
    if (body.color !== undefined) patch.color = body.color;
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.url !== undefined) CACHE.delete(id);
    const [row] = await db
      .update(calendarFeeds)
      .set(patch)
      .where(and(eq(calendarFeeds.id, id), eq(calendarFeeds.ownerId, userId)))
      .returning(feedView);
    if (!row) throw notFound("feed");
    return row;
  });

  /** Remove a feed. */
  app.delete("/calendar/feeds/:id", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const rows = await db
      .delete(calendarFeeds)
      .where(and(eq(calendarFeeds.id, id), eq(calendarFeeds.ownerId, userId)))
      .returning({ id: calendarFeeds.id });
    if (!rows.length) throw notFound("feed");
    CACHE.delete(id);
    return { ok: true };
  });

  /**
   * Merged events across all enabled feeds, overlapping [start,end] (inclusive
   * YYYY-MM-DD). Read-only. Events already converted to Hermes blocks are
   * filtered out. A feed that fails to fetch/parse is skipped (its error is
   * recorded) so one bad feed doesn't sink the rest.
   */
  app.get("/calendar/events", async (req) => {
    const userId = requireUser(req);
    const q = z
      .object({
        start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        refresh: z.enum(["0", "1"]).optional(),
      })
      .parse(req.query);
    const force = q.refresh === "1";

    const feeds = await db
      .select(feedView)
      .from(calendarFeeds)
      .where(and(eq(calendarFeeds.ownerId, userId), eq(calendarFeeds.enabled, true)));

    const converted = await db
      .select({ feedId: calendarConverted.feedId, uid: calendarConverted.uid })
      .from(calendarConverted)
      .where(eq(calendarConverted.ownerId, userId));
    const convertedKeys = new Set(converted.map((c) => `${c.feedId}|${c.uid}`));

    const out: Array<ParsedEvent & { feedId: string; feedName: string; color: string }> = [];
    for (const feed of feeds) {
      try {
        const text = await icsFor(feed, force);
        const events = eventsInRange(text, q.start, q.end);
        for (const ev of events) {
          if (convertedKeys.has(`${feed.id}|${ev.uid}`)) continue;
          out.push({ ...ev, feedId: feed.id, feedName: feed.name, color: feed.color });
        }
        await db
          .update(calendarFeeds)
          .set({ lastFetchedAt: new Date(), lastError: null })
          .where(eq(calendarFeeds.id, feed.id));
      } catch (err) {
        await db
          .update(calendarFeeds)
          .set({ lastError: err instanceof Error ? err.message : "fetch failed" })
          .where(eq(calendarFeeds.id, feed.id));
      }
    }
    out.sort((a, b) => a.start.localeCompare(b.start));
    return { events: out };
  });

  /**
   * Convert a feed event into a Hermes "event" block (a happening). Records the
   * (feed, uid) so the source event disappears from the feed display.
   */
  app.post("/calendar/convert", async (req, reply) => {
    const userId = requireUser(req);
    const body = z
      .object({
        feedId: z.string().uuid(),
        uid: z.string().min(1),
        summary: z.string().default(""),
        description: z.string().default(""),
        location: z.string().default(""),
        start: z.string().min(1),
        end: z.string().nullable().optional(),
        allDay: z.boolean().default(false),
      })
      .parse(req.body);

    // Resolve this user's "event" type. Match by name case-insensitively
    // (accounts seeded by older versions may capitalize it), falling back to a
    // built-in type whose schema carries a datespan — the shape of an event.
    const ownTypes = await db
      .select()
      .from(blockTypes)
      .where(eq(blockTypes.ownerId, userId));
    const type =
      ownTypes.find((t) => t.name.trim().toLowerCase() === "event") ??
      ownTypes.find(
        (t) =>
          t.builtin &&
          !t.isText &&
          !t.propertySchema?.status_field && // excludes task (which has a status)
          (t.propertySchema?.fields ?? []).some((f) => f.type === "datespan"),
      );
    if (!type) throw badRequest("No event type found — create an 'event' type first");

    // Map onto the type's actual fields (the datespan key may differ from "when"
    // on older accounts; title/description/location follow the built-in keys).
    const fields = type.propertySchema?.fields ?? [];
    const spanKey = fields.find((f) => f.type === "datespan")?.key ?? "when";
    const properties: Record<string, unknown> = {
      title: body.summary || "(untitled event)",
      [spanKey]: { start: body.start, end: body.end ?? body.start },
    };
    if (fields.some((f) => f.key === "description")) properties.description = body.description || "";
    if (body.location && fields.some((f) => f.key === "location")) properties.location = body.location;
    const embedSource = computeEmbedSource(type, { content: null, properties });

    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(blocks)
        .values({
          ownerId: userId,
          blockTypeId: type.id,
          content: null,
          properties,
          embedSource,
          embedSourceHash: null,
          blockTypeSchemaVersion: type.schemaVersion,
        })
        .returning({ id: blocks.id });
      await tx
        .insert(calendarConverted)
        .values({ ownerId: userId, feedId: body.feedId, uid: body.uid, blockId: row!.id })
        .onConflictDoNothing();
      return row!;
    });

    reply.code(201);
    return { blockId: created.id };
  });
}
