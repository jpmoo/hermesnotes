import { lookup } from "node:dns/promises";
import { isIP, isIPv4 } from "node:net";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
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

/**
 * The property values a feed event dictates, keyed by the type's own field keys.
 * This is both what a conversion seeds and the baseline recorded on the sync row
 * (`last_feed`) for later change detection.
 */
function feedProperties(type: EventType, ev: EventLike): Record<string, unknown> {
  const fields = type.propertySchema?.fields ?? [];
  const spanKey = fields.find((f) => f.type === "datespan")?.key ?? "when";
  const props: Record<string, unknown> = {
    title: ev.summary || "(untitled event)",
    [spanKey]: { start: ev.start, end: ev.end ?? ev.start },
  };
  if (fields.some((f) => f.key === "description")) props.description = ev.description || "";
  if (fields.some((f) => f.key === "location")) props.location = ev.location || "";
  return props;
}

/** Build an event block's properties from a feed event, honoring the type's field keys. */
function eventProperties(type: EventType, ev: EventLike, base: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...base, ...feedProperties(type, ev) };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A synced block and the feed instance it should mirror. */
interface SyncTarget {
  ev: EventLike;
  linkId: string;
  /** What the feed reported last time we synced (null = no baseline recorded). */
  lastFeed: Record<string, unknown> | null;
}

/**
 * Mirror feed changes into synced blocks — a three-way merge, never a wholesale
 * overwrite. For each field the feed owns, the new feed value is taken only when
 * the FEED changed it and the user hasn't edited it here since the last sync;
 * a field the user has touched stays theirs, so notes added to a synced event
 * are never lost to a later feed fetch. Rows with no recorded baseline adopt the
 * feed's current values as the baseline without touching the block at all.
 */
async function applySyncUpdates(userId: string, targets: Map<string, SyncTarget>): Promise<void> {
  const ids = [...targets.keys()];
  const rows = await db
    .select()
    .from(blocks)
    .where(and(eq(blocks.ownerId, userId), inArray(blocks.id, ids)));
  const typeCache = new Map<string, EventType>();
  for (const row of rows) {
    const target = targets.get(row.id);
    if (!target || !row.blockTypeId) continue;
    let type = typeCache.get(row.blockTypeId);
    if (!type) {
      const [t] = await db.select().from(blockTypes).where(eq(blockTypes.id, row.blockTypeId)).limit(1);
      if (!t) continue;
      type = t;
      typeCache.set(row.blockTypeId, t);
    }
    const base = (row.properties as Record<string, unknown>) ?? {};
    const feedNow = feedProperties(type, target.ev);
    const prev = target.lastFeed;

    // With a baseline, merge field by field. Without one, skip straight to
    // recording the baseline: we can't tell feed values from user edits yet, and
    // guessing wrong would destroy the user's text.
    if (prev) {
      const next = { ...base };
      let changed = false;
      for (const [key, value] of Object.entries(feedNow)) {
        if (same(value, prev[key])) continue; // feed hasn't changed this field
        if (!same(base[key], prev[key])) continue; // the user edited it — keep theirs
        next[key] = value;
        changed = true;
      }
      if (changed) {
        const embedSource = computeEmbedSource(type, { content: null, properties: next });
        await db
          .update(blocks)
          .set({
            properties: next,
            embedSource,
            embedSourceHash: null,
            version: sql`${blocks.version} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(blocks.id, row.id));
      }
    }

    if (!same(feedNow, prev)) {
      await db
        .update(calendarConverted)
        .set({ lastFeed: feedNow })
        .where(eq(calendarConverted.id, target.linkId));
    }
  }
}

/** In-memory raw-ICS cache, keyed by feed id. Refetched past the TTL. */
const CACHE = new Map<string, { fetchedAt: number; text: string }>();
const TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;
/** Hard cap on a feed body. Parsing is synchronous, so an unbounded document
 * would block the event loop; 5 MB is far above any real calendar. */
const MAX_ICS_BYTES = 5 * 1024 * 1024;
/** Bound the cache so N feeds can't pin unbounded heap forever. */
const MAX_CACHE_ENTRIES = 200;
const MAX_REDIRECTS = 5;

/** True for addresses that must never be reachable from a user-supplied feed
 * URL: loopback, private, link-local (incl. cloud metadata), CGNAT, multicast. */
function isBlockedIp(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip; // IPv4-mapped IPv6
  if (isIPv4(v4)) {
    const [a = 0, b = 0] = v4.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local + 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 192 && b === 0) return true;
    if (a === 198 && (b === 18 || b === 19) ) return true;
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  const s = ip.toLowerCase();
  if (s === "::" || s === "::1") return true;
  return /^(fc|fd|fe8|fe9|fea|feb)/.test(s); // ULA + link-local
}

/** Resolve a URL's host and reject it if it points anywhere internal. Applied
 * per redirect hop — an allowlist checked only at save time would be bypassed
 * by a redirect (and re-resolving each hop also blunts DNS rebinding). */
async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("invalid feed URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("feed URL must be http(s)");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length) throw new Error("feed host did not resolve");
  for (const a of addrs) if (isBlockedIp(a.address)) throw new Error("feed URL resolves to a non-public address");
  return u;
}

/** Read a response body, aborting past MAX_ICS_BYTES. */
async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_ICS_BYTES) throw new Error("feed too large");
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_ICS_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("feed too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fetchIcs(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // Some providers publish webcal:// URLs — same content over https.
    let next = url.replace(/^webcal:\/\//i, "https://");
    // Follow redirects by hand so every hop is re-validated against the
    // internal-address rules above.
    for (let hop = 0; ; hop++) {
      const target = await assertPublicUrl(next);
      const res = await fetch(target, {
        signal: controller.signal,
        headers: { "User-Agent": "HermesNotes/1.0", Accept: "text/calendar, text/plain, */*" },
        redirect: "manual",
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) throw new Error(`feed responded ${res.status}`);
        if (hop >= MAX_REDIRECTS) throw new Error("too many redirects");
        next = new URL(loc, target).toString();
        continue;
      }
      if (!res.ok) throw new Error(`feed responded ${res.status}`);
      return await readCapped(res);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Get a feed's ICS text (cached), refetching past the TTL or when forced. */
async function icsFor(feed: { id: string; url: string }, force: boolean): Promise<string> {
  const hit = CACHE.get(feed.id);
  if (!force && hit && Date.now() - hit.fetchedAt < TTL_MS) return hit.text;
  const text = await fetchIcs(feed.url);
  // Evict the oldest entry once the cache is full (Map preserves insertion order).
  if (!CACHE.has(feed.id) && CACHE.size >= MAX_CACHE_ENTRIES) {
    const oldest = CACHE.keys().next().value;
    if (oldest) CACHE.delete(oldest);
  }
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
    //
    // A link only counts while its block is live: archiving the synced event has
    // to hand the original feed event back (the block is hidden everywhere else,
    // so suppressing the feed event too would make the event vanish outright).
    // The row itself is kept, so unarchiving silently resumes the sync.
    const links = await db
      .select({
        id: calendarConverted.id,
        feedId: calendarConverted.feedId,
        uid: calendarConverted.uid,
        blockId: calendarConverted.blockId,
        lastFeed: calendarConverted.lastFeed,
      })
      .from(calendarConverted)
      .innerJoin(blocks, eq(blocks.id, calendarConverted.blockId))
      .where(and(eq(calendarConverted.ownerId, userId), isNull(blocks.archivedAt)));
    const syncByKey = new Map<string, { blockId: string; linkId: string; lastFeed: Record<string, unknown> | null }>();
    for (const l of links) {
      if (l.blockId) {
        syncByKey.set(`${l.feedId}|${l.uid}`, {
          blockId: l.blockId,
          linkId: l.id,
          lastFeed: l.lastFeed ?? null,
        });
      }
    }

    const nowMs = Date.now();
    const out: Array<ParsedEvent & { feedId: string; feedName: string; color: string }> = [];
    // blockId → the feed instance the synced event should mirror (nearest to now).
    const syncTargets = new Map<string, SyncTarget>();
    for (const feed of feeds) {
      try {
        const text = await icsFor(feed, force);
        const events = eventsInRange(text, q.start, q.end).map((e) => zoneEvent(e, tz));
        for (const ev of events) {
          const link = syncByKey.get(`${feed.id}|${ev.uid}`);
          if (link) {
            // Hidden from the feed; the linked block mirrors the nearest instance.
            const prev = syncTargets.get(link.blockId);
            const dist = (e: EventLike) => Math.abs(new Date(e.start).getTime() - nowMs);
            if (!prev || dist(ev) < dist(prev.ev)) {
              syncTargets.set(link.blockId, { ev, linkId: link.linkId, lastFeed: link.lastFeed });
            }
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

    // The feed must be the caller's own — otherwise a user could create link
    // rows referencing someone else's feed id.
    const [feed] = await db
      .select({ id: calendarFeeds.id })
      .from(calendarFeeds)
      .where(and(eq(calendarFeeds.id, body.feedId), eq(calendarFeeds.ownerId, userId)))
      .limit(1);
    if (!feed) throw notFound("calendar feed");

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
          .values({
            ownerId: userId,
            feedId: body.feedId,
            uid: body.uid,
            blockId: row!.id,
            mode: "sync",
            // Baseline: what the feed says right now, which is exactly what the
            // block was seeded with — so the first later edit reads as the user's.
            lastFeed: feedProperties(type, body),
          })
          .onConflictDoNothing();
      }
      return row!;
    });

    reply.code(201);
    return { blockId: created.id };
  });
}
