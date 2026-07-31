import { lookup } from "node:dns/promises";
import { isIP, isIPv4 } from "node:net";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
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
 * The property key holding a joined feed event's own description, verbatim from
 * the feed. Deliberately NOT the block's `description`: that one belongs to the
 * user, and the feed must never overwrite what they wrote there. Rendered
 * read-only in the UI, so the two live side by side.
 */
export const FEED_NOTES_KEY = "feed_description";

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
    [FEED_NOTES_KEY]: ev.description || "",
  };
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
 * overwrite. For each field the feed owns: an absent value is filled in (that
 * can't destroy anything), and an existing one is replaced only when the FEED
 * changed it and the user hasn't edited it here since the last sync. A field the
 * user has touched stays theirs, so notes added to a joined event are never lost
 * to a later feed fetch — and with no recorded baseline yet, nothing the user
 * already has is touched at all.
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

    const next = { ...base };
    let changed = false;
    for (const [key, value] of Object.entries(feedNow)) {
      const cur = base[key];
      // The block has no value for this field at all, so filling it in can't
      // destroy anything — and it's how a newly-tracked field (the feed's own
      // description) reaches events joined before that field existed.
      if (cur === undefined) {
        // The feed-notes key is always recorded, even empty: its presence is how
        // the UI knows this event is feed-joined, so it can show the section as
        // "(empty)" rather than leaving the user wondering.
        if ((value == null || value === "") && key !== FEED_NOTES_KEY) continue;
        next[key] = value ?? "";
        changed = true;
        continue;
      }
      // Past that, changing a field needs a baseline to tell a feed change from
      // an edit made here. Without one, leave the user's value alone.
      if (!prev || !(key in prev)) continue;
      if (same(value, prev[key])) continue; // feed hasn't changed this field
      if (!same(cur, prev[key])) continue; // the user edited it — keep theirs
      next[key] = value;
      changed = true;
    }
    if (changed) {
      const embedSource = computeEmbedSource(type, { content: null, properties: next });
      // Deliberately does NOT bump `version`. This is a background mirror, not a
      // user edit: bumping it would invalidate the optimistic-concurrency token
      // an open editor is holding, so a save the user had in flight would 409 and
      // their typing would be thrown away — which is exactly the data loss this
      // whole area was fixed for. A client writing its own snapshot afterwards
      // may drop a feed field; the next fetch simply puts it back.
      await db
        .update(blocks)
        .set({
          properties: next,
          embedSource,
          embedSourceHash: null,
          updatedAt: new Date(),
        })
        .where(eq(blocks.id, row.id));
    }

    if (!same(feedNow, prev)) {
      await db
        .update(calendarConverted)
        .set({ lastFeed: feedNow })
        .where(eq(calendarConverted.id, target.linkId));
    }
  }
}

/**
 * A feed body we've already read, with the validators to ask about it again.
 * Held in this process for speed and on the feed row for a restart.
 */
interface Cached {
  text: string;
  fetchedAt: number;
  etag: string | null;
  lastModified: string | null;
}

/** In-memory raw-ICS cache, keyed by feed id. Refreshed past the TTL. */
const CACHE = new Map<string, Cached>();
const TTL_MS = 10 * 60 * 1000;
/**
 * Generous, because nothing waits on it any more: a stale copy is served while
 * the refresh runs. Outlook in particular can take the better part of a minute
 * the first time it's asked for a published calendar.
 */
const FETCH_TIMEOUT_MS = 45000;
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

/** A failure worth showing someone: what happened, and what to do about it. */
class FeedError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly detail: string | null = null,
    /** Transient things (timeouts, 5xx) are worth one more try straight away. */
    readonly retryable = false,
  ) {
    super(message);
    this.name = "FeedError";
  }
}

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  410: "Gone",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

const REPUBLISH_HINT =
  "The calendar host rejected this address. A published link stops working once the calendar is unpublished, republished, or its sharing is changed — Outlook in particular issues a brand-new address each time. Open the calendar's sharing settings, copy the ICS address again, and paste it in above.";

function statusHint(status: number): string | null {
  if (status === 400 || status === 403 || status === 404 || status === 410) return REPUBLISH_HINT;
  if (status === 401)
    return "This address needs credentials, which a subscription can't supply. Use the calendar's secret/private ICS address instead of one behind a sign-in.";
  if (status === 429)
    return "The calendar host is asking us to slow down. Feeds refresh every 10 minutes; this should clear on its own.";
  if (status >= 500)
    return "The calendar host is having trouble at its end. The last copy we read is still being shown, and the refresh will be retried.";
  return null;
}

/** Turn whatever fetch threw into something a person can act on. */
function describeFailure(err: unknown): { message: string; status: number | null; detail: string | null } {
  if (err instanceof FeedError) return { message: err.message, status: err.status, detail: err.detail };
  const name = err instanceof Error ? err.name : "";
  if (name === "AbortError" || name === "TimeoutError") {
    return {
      message: `no response within ${Math.round(FETCH_TIMEOUT_MS / 1000)}s`,
      status: null,
      detail:
        "The calendar host didn't answer in time. Outlook can be slow the first time it's asked for a published calendar; the refresh runs again in the background, so this often clears by itself.",
    };
  }
  const code = (err as { cause?: { code?: unknown } })?.cause?.code;
  const codes: Record<string, string> = {
    ENOTFOUND: "That host doesn't exist — check the address for a typo.",
    EAI_AGAIN: "The host couldn't be looked up. This is usually a DNS hiccup on our side.",
    ECONNREFUSED: "The host refused the connection.",
    ECONNRESET: "The host closed the connection partway through.",
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: "The host's TLS certificate couldn't be verified.",
    CERT_HAS_EXPIRED: "The host's TLS certificate has expired.",
  };
  if (typeof code === "string") {
    return { message: `couldn't reach the calendar host (${code})`, status: null, detail: codes[code] ?? null };
  }
  return {
    message: err instanceof Error ? err.message : "fetch failed",
    status: null,
    detail: null,
  };
}

interface FetchResult {
  /** null when the host said 304: what we already hold is still current. */
  text: string | null;
  etag: string | null;
  lastModified: string | null;
}

async function fetchIcs(url: string, have: Cached | null): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // Some providers publish webcal:// URLs — same content over https.
    let next = url.replace(/^webcal:\/\//i, "https://");
    // Follow redirects by hand so every hop is re-validated against the
    // internal-address rules above.
    for (let hop = 0; ; hop++) {
      const target = await assertPublicUrl(next);
      const headers: Record<string, string> = {
        "User-Agent": "HermesNotes/1.0",
        Accept: "text/calendar, text/plain, */*",
      };
      // Ask only for what's changed. Hosts that honour this answer 304 with no
      // body at all, which is what makes a frequent refresh cheap.
      if (have?.etag) headers["If-None-Match"] = have.etag;
      if (have?.lastModified) headers["If-Modified-Since"] = have.lastModified;
      const res = await fetch(target, { signal: controller.signal, headers, redirect: "manual" });
      if (res.status === 304 && have) {
        return { text: null, etag: have.etag, lastModified: have.lastModified };
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) throw new FeedError(`redirect with no destination (${res.status})`, res.status);
        if (hop >= MAX_REDIRECTS) throw new FeedError("too many redirects");
        next = new URL(loc, target).toString();
        continue;
      }
      if (!res.ok) {
        // Some hosts explain themselves in the body; Outlook sends nothing at
        // all, which is itself worth showing rather than a bare status.
        const body = await res.text().catch(() => "");
        const snippet = body.trim().slice(0, 300);
        const hint = statusHint(res.status);
        const label = STATUS_TEXT[res.status] ?? "";
        throw new FeedError(
          `the calendar host answered ${res.status}${label ? ` ${label}` : ""}`,
          res.status,
          snippet ? `${hint ? `${hint}\n\n` : ""}The host said: ${snippet}` : hint,
          res.status >= 500 || res.status === 429,
        );
      }
      return {
        text: await readCapped(res),
        etag: res.headers.get("etag"),
        lastModified: res.headers.get("last-modified"),
      };
    }
  } catch (err) {
    if (err instanceof FeedError) throw err;
    const name = err instanceof Error ? err.name : "";
    if (name === "AbortError" || name === "TimeoutError") throw err; // described upstream
    throw Object.assign(err as Error, { retryable: true });
  } finally {
    clearTimeout(timer);
  }
}

/** Feed columns the fetching machinery needs (not the ones sent to the client). */
const feedRow = {
  id: calendarFeeds.id,
  url: calendarFeeds.url,
  cacheText: calendarFeeds.cacheText,
  cachedAt: calendarFeeds.cachedAt,
  etag: calendarFeeds.etag,
  lastModified: calendarFeeds.lastModified,
  lastError: calendarFeeds.lastError,
  lastStatus: calendarFeeds.lastStatus,
  lastDetail: calendarFeeds.lastDetail,
  lastErrorAt: calendarFeeds.lastErrorAt,
};
interface FeedRow {
  id: string;
  url: string;
  cacheText: string | null;
  cachedAt: Date | null;
  etag: string | null;
  lastModified: string | null;
  lastError: string | null;
  lastStatus: number | null;
  lastDetail: string | null;
  lastErrorAt: Date | null;
}

/** What we hold for a feed: this process's copy, or the one on its row. */
function held(feed: FeedRow): Cached | null {
  const mem = CACHE.get(feed.id);
  if (mem) return mem;
  if (feed.cacheText == null || !feed.cachedAt) return null;
  const entry: Cached = {
    text: feed.cacheText,
    fetchedAt: feed.cachedAt.getTime(),
    etag: feed.etag,
    lastModified: feed.lastModified,
  };
  remember(feed.id, entry);
  return entry;
}

function remember(id: string, entry: Cached): void {
  // Evict the oldest entry once the cache is full (Map preserves insertion order).
  if (!CACHE.has(id) && CACHE.size >= MAX_CACHE_ENTRIES) {
    const oldest = CACHE.keys().next().value;
    if (oldest) CACHE.delete(oldest);
  }
  CACHE.set(id, entry);
}

type Refresh = { ok: true; entry: Cached } | { ok: false; failure: ReturnType<typeof describeFailure> };

/** One refresh per feed at a time, however many callers ask for it. */
const inflight = new Map<string, Promise<Refresh>>();

/**
 * Pull the feed and store what came back — body, validators, and the outcome —
 * on the feed row. Never throws: a failure is recorded and reported, because the
 * caller's job is usually to carry on with the copy it already has.
 */
function refreshFeed(feed: FeedRow): Promise<Refresh> {
  const running = inflight.get(feed.id);
  if (running) return running;
  const run = (async (): Promise<Refresh> => {
    const have = held(feed);
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetchIcs(feed.url, have);
        const unchanged = res.text === null && have !== null;
        const entry: Cached = unchanged
          ? { ...have!, fetchedAt: Date.now() }
          : { text: res.text ?? "", fetchedAt: Date.now(), etag: res.etag, lastModified: res.lastModified };
        remember(feed.id, entry);
        await db
          .update(calendarFeeds)
          .set({
            // A 304 means the body on the row is still the right one — no point
            // rewriting a few hundred KB to say so.
            ...(unchanged ? {} : { cacheText: entry.text, etag: entry.etag, lastModified: entry.lastModified }),
            cachedAt: new Date(entry.fetchedAt),
            lastFetchedAt: new Date(),
            lastError: null,
            lastStatus: null,
            lastDetail: null,
            lastErrorAt: null,
          })
          .where(eq(calendarFeeds.id, feed.id));
        return { ok: true, entry };
      } catch (err) {
        const retryable =
          (err instanceof FeedError && err.retryable) ||
          (err as { retryable?: boolean })?.retryable === true;
        if (retryable && attempt === 0) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        const failure = describeFailure(err);
        await db
          .update(calendarFeeds)
          .set({
            lastError: failure.message,
            lastStatus: failure.status,
            lastDetail: failure.detail,
            lastErrorAt: new Date(),
          })
          .where(eq(calendarFeeds.id, feed.id));
        return { ok: false, failure };
      }
    }
  })().finally(() => inflight.delete(feed.id));
  inflight.set(feed.id, run);
  return run;
}

/**
 * A feed's ICS text. Anything we already hold is handed back straight away and
 * refreshed behind the request — waiting on someone else's calendar server is
 * what made opening a calendar feel slow. `force` (the refresh button) waits for
 * the real thing; only a feed we've never read successfully has to.
 */
async function icsFor(feed: FeedRow, force: boolean): Promise<{ text: string; stale: boolean }> {
  const have = held(feed);
  const fail = (r: Refresh & { ok: false }): never => {
    throw new FeedError(r.failure.message, r.failure.status, r.failure.detail);
  };
  if (force) {
    const res = await refreshFeed(feed);
    if (res.ok) return { text: res.entry.text, stale: false };
    if (have) return { text: have.text, stale: true };
    return fail(res);
  }
  if (have && Date.now() - have.fetchedAt < TTL_MS) return { text: have.text, stale: false };
  if (have) {
    void refreshFeed(feed); // stale-while-revalidate
    return { text: have.text, stale: true };
  }
  const res = await refreshFeed(feed);
  if (res.ok) return { text: res.entry.text, stale: false };
  return fail(res);
}

const feedView = {
  id: calendarFeeds.id,
  name: calendarFeeds.name,
  url: calendarFeeds.url,
  color: calendarFeeds.color,
  enabled: calendarFeeds.enabled,
  lastFetchedAt: calendarFeeds.lastFetchedAt,
  lastError: calendarFeeds.lastError,
  lastStatus: calendarFeeds.lastStatus,
  lastDetail: calendarFeeds.lastDetail,
  lastErrorAt: calendarFeeds.lastErrorAt,
  cachedAt: calendarFeeds.cachedAt,
  sort: calendarFeeds.sort,
};

export async function calendarRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  /**
   * Keep the stored copies warm in the background, so opening a calendar reads
   * from disk rather than waiting on someone else's server. A feed that just
   * failed is left alone for a while: a revoked publish link would otherwise be
   * retried every few minutes forever, and the answer wouldn't change.
   */
  const SWEEP_MS = 5 * 60 * 1000;
  const ERROR_BACKOFF_MS = 30 * 60 * 1000;
  const SWEEP_CONCURRENCY = 3;
  let sweeping = false;
  const sweep = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const all = await db.select(feedRow).from(calendarFeeds).where(eq(calendarFeeds.enabled, true));
      const now = Date.now();
      const due = all.filter((f) => {
        if (f.lastErrorAt && now - f.lastErrorAt.getTime() < ERROR_BACKOFF_MS) return false;
        return !f.cachedAt || now - f.cachedAt.getTime() > TTL_MS;
      });
      for (let i = 0; i < due.length; i += SWEEP_CONCURRENCY) {
        await Promise.all(due.slice(i, i + SWEEP_CONCURRENCY).map((f) => refreshFeed(f)));
      }
    } catch (err) {
      app.log.warn({ err }, "calendar feed sweep failed");
    } finally {
      sweeping = false;
    }
  };
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  app.addHook("onReady", async () => {
    sweepTimer = setInterval(() => void sweep(), SWEEP_MS);
    sweepTimer.unref?.();
    void sweep(); // warm on boot: the first calendar opened shouldn't be the one that waits
  });
  app.addHook("onClose", async () => {
    if (sweepTimer) clearInterval(sweepTimer);
  });

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
    if (body.url !== undefined) {
      // A new address is a different calendar: the stored body, its validators
      // and any complaint about the old one all stop applying.
      CACHE.delete(id);
      patch.cacheText = null;
      patch.cachedAt = null;
      patch.etag = null;
      patch.lastModified = null;
      patch.lastError = null;
      patch.lastStatus = null;
      patch.lastDetail = null;
      patch.lastErrorAt = null;
    }
    const [row] = await db
      .update(calendarFeeds)
      .set(patch)
      .where(and(eq(calendarFeeds.id, id), eq(calendarFeeds.ownerId, userId)))
      .returning(feedView);
    if (!row) throw notFound("feed");
    return row;
  });

  /**
   * Fetch this feed now and report what happened — the diagnostics dialog's
   * "Try again", and the only way to find out whether a fix worked without
   * waiting for the next sweep.
   */
  app.post("/calendar/feeds/:id/refresh", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [feed] = await db
      .select(feedRow)
      .from(calendarFeeds)
      .where(and(eq(calendarFeeds.id, id), eq(calendarFeeds.ownerId, userId)))
      .limit(1);
    if (!feed) throw notFound("feed");
    await refreshFeed(feed);
    const [row] = await db.select(feedView).from(calendarFeeds).where(eq(calendarFeeds.id, id)).limit(1);
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
      .select({ ...feedRow, name: calendarFeeds.name, color: calendarFeeds.color })
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
    // True when at least one feed is showing a stored copy while it refreshes
    // behind us: the client asks again shortly to pick up what arrives.
    let stale = false;
    // All feeds at once. Serially, a single slow calendar host held up every
    // other one — and it only takes one Outlook feed to make the whole page wait.
    await Promise.all(
      feeds.map(async (feed) => {
        try {
          const got = await icsFor(feed, force);
          if (got.stale) stale = true;
          const events = eventsInRange(got.text, q.start, q.end).map((e) => zoneEvent(e, tz));
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
        } catch (err) {
          // A fetch failure has already been recorded against the feed, in more
          // detail than we could reconstruct here; anything else is the parse.
          if (err instanceof FeedError) return;
          await db
            .update(calendarFeeds)
            .set({
              lastError: "the calendar couldn't be read",
              lastDetail:
                "The address answered, but what came back isn't a calendar we can parse. Check that it's the ICS address rather than a web page.",
              lastErrorAt: new Date(),
            })
            .where(eq(calendarFeeds.id, feed.id));
        }
      }),
    );

    // Push feed changes into the synced blocks (feed is the source of truth for
    // these). Only writes when a value actually changed, so the steady state is
    // read-only.
    if (syncTargets.size) await applySyncUpdates(userId, syncTargets);

    out.sort((a, b) => a.start.localeCompare(b.start));
    return { events: out, stale };
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
