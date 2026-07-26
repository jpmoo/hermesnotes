import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { blockTypes, blocks, calendarConverted, calendarFeeds, userSettings } from "@hermes/db";
import { db } from "../db.js";
import { badRequest, notFound } from "../lib/errors.js";
import { authenticate, requireUser } from "../auth/middleware.js";
import { computeEmbedSource } from "../blocks/embed-source.js";
import { eventsInRange, zoneEvent, type ParsedEvent } from "./ical.js";

type EventLike = { summary: string; description: string; location: string; start: string; end?: string | null };
type EventType = typeof blockTypes.$inferSelect;

/**
 * Resolve this user's "event" type. Matched by name case-insensitively (older
 * accounts may capitalize it), falling back to a built-in non-text type whose
 * schema carries a datespan but no status — the shape of an event, not a task.
 */
async function resolveEventType(userId: string): Promise<EventType> {
  const ownTypes = await db.select().from(blockTypes).where(eq(blockTypes.ownerId, userId));
  const type =
    ownTypes.find((t) => t.name.trim().toLowerCase() === "event") ??
    ownTypes.find(
      (t) =>
        t.builtin &&
        !t.isText &&
        !t.propertySchema?.status_field &&
        (t.propertySchema?.fields ?? []).some((f) => f.type === "datespan"),
    );
  if (!type) throw badRequest("No event type found — create an 'event' type first");
  return type;
}

/** Build an event block's properties from a feed event, honoring the type's field keys. */
function eventProperties(type: EventType, ev: EventLike, base: Record<string, unknown> = {}): Record<string, unknown> {
  const fields = type.propertySchema?.fields ?? [];
  const spanKey = fields.find((f) => f.type === "datespan")?.key ?? "when";
  const props: Record<string, unknown> = {
    ...base,
    title: ev.summary || "(untitled event)",
    [spanKey]: { start: ev.start, end: ev.end ?? ev.start },
  };
  if (fields.some((f) => f.key === "description")) props.description = ev.description || "";
  if (fields.some((f) => f.key === "location")) props.location = ev.location || "";
  return props;
}

/**
 * Mirror feed changes into synced blocks. Fetches the target blocks, rebuilds
 * their properties from the feed instance, and writes only those that actually
 * changed (so an unchanged feed is a no-op). Feed is the source of truth here.
 */
async function applySyncUpdates(userId: string, targets: Map<string, EventLike>): Promise<void> {
  const ids = [...targets.keys()];
  const rows = await db
    .select()
    .from(blocks)
    .where(and(eq(blocks.ownerId, userId), inArray(blocks.id, ids)));
  const typeCache = new Map<string, EventType>();
  for (const row of rows) {
    const ev = targets.get(row.id);
    if (!ev || !row.blockTypeId) continue;
    let type = typeCache.get(row.blockTypeId);
    if (!type) {
      const [t] = await db.select().from(blockTypes).where(eq(blockTypes.id, row.blockTypeId)).limit(1);
      if (!t) continue;
      type = t;
      typeCache.set(row.blockTypeId, t);
    }
    const base = (row.properties as Record<string, unknown>) ?? {};
    const nextProps = eventProperties(type, ev, base);
    if (JSON.stringify(nextProps) === JSON.stringify(base)) continue;
    const embedSource = computeEmbedSource(type, { content: null, properties: nextProps });
    await db
      .update(blocks)
      .set({
        properties: nextProps,
        embedSource,
        embedSourceHash: null,
        version: sql`${blocks.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(blocks.id, row.id));
  }
}

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

    // Show every feed event in the user's configured timezone.
    const [settings] = await db
      .select({ tz: userSettings.timezone })
      .from(userSettings)
      .where(eq(userSettings.userId, userId))
      .limit(1);
    const tz = settings?.tz || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

    // Sync links: (feed,uid) → block id. Only "sync" conversions have a row;
    // deleting the block cascades the row away, so the event returns to the feed.
    const links = await db
      .select({ feedId: calendarConverted.feedId, uid: calendarConverted.uid, blockId: calendarConverted.blockId })
      .from(calendarConverted)
      .where(eq(calendarConverted.ownerId, userId));
    const syncByKey = new Map<string, string>();
    for (const l of links) if (l.blockId) syncByKey.set(`${l.feedId}|${l.uid}`, l.blockId);

    const nowMs = Date.now();
    const out: Array<ParsedEvent & { feedId: string; feedName: string; color: string }> = [];
    // blockId → the feed instance the synced event should mirror (nearest to now).
    const syncTargets = new Map<string, EventLike>();
    for (const feed of feeds) {
      try {
        const text = await icsFor(feed, force);
        const events = eventsInRange(text, q.start, q.end).map((e) => zoneEvent(e, tz));
        for (const ev of events) {
          const linkedBlock = syncByKey.get(`${feed.id}|${ev.uid}`);
          if (linkedBlock) {
            // Hidden from the feed; the linked block mirrors the nearest instance.
            const prev = syncTargets.get(linkedBlock);
            const dist = (e: EventLike) => Math.abs(new Date(e.start).getTime() - nowMs);
            if (!prev || dist(ev) < dist(prev)) syncTargets.set(linkedBlock, ev);
            continue;
          }
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

    // Push feed changes into the synced blocks (feed is the source of truth for
    // these). Only writes when a value actually changed, so the steady state is
    // read-only.
    if (syncTargets.size) await applySyncUpdates(userId, syncTargets);

    out.sort((a, b) => a.start.localeCompare(b.start));
    return { events: out };
  });

  /**
   * Convert a feed event into a Hermes "event" block. Two modes:
   *   sync — links the block to the feed event: the block keeps up with feed
   *          changes, the event is hidden from the feed, and deleting the block
   *          brings the event back.
   *   copy — a one-off copy: no link, the feed event stays visible.
   */
  app.post("/calendar/convert", async (req, reply) => {
    const userId = requireUser(req);
    const body = z
      .object({
        feedId: z.string().uuid(),
        uid: z.string().min(1),
        mode: z.enum(["sync", "copy"]).default("sync"),
        summary: z.string().default(""),
        description: z.string().default(""),
        location: z.string().default(""),
        start: z.string().min(1),
        end: z.string().nullable().optional(),
        allDay: z.boolean().default(false),
      })
      .parse(req.body);

    const type = await resolveEventType(userId);
    const properties = eventProperties(type, body);
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
      if (body.mode === "sync") {
        await tx
          .insert(calendarConverted)
          .values({ ownerId: userId, feedId: body.feedId, uid: body.uid, blockId: row!.id, mode: "sync" })
          .onConflictDoNothing();
      }
      return row!;
    });

    reply.code(201);
    return { blockId: created.id };
  });
}
