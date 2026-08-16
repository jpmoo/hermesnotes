import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { env } from "./env.js";
import { getAuthSecret } from "./config.js";
import { isDbReady } from "./db.js";
import { HttpError } from "./lib/errors.js";
import { authRoutes } from "./auth/routes.js";
import { settingsRoutes } from "./settings/routes.js";
import { blockRoutes } from "./blocks/routes.js";
import { mcpRoutes } from "./mcp/routes.js";
import { oauthRoutes } from "./auth/oauth.js";
import { blockTypeRoutes } from "./blocks/block-types-routes.js";
import { collectionRoutes } from "./collections/routes.js";
import { todayRoutes } from "./today/routes.js";
import { reviewRoutes } from "./review/routes.js";
import { attachmentRoutes } from "./attachments/routes.js";
import { bannerRoutes } from "./banners/routes.js";
import { calendarRoutes } from "./calendar/routes.js";
import { assistantRoutes } from "./assistant/routes.js";
import { setupRoutes } from "./setup/routes.js";
import { backupRoutes } from "./backup/routes.js";
import { exportRoutes } from "./export/routes.js";
import { adminRoutes } from "./admin/routes.js";
import { eventRoutes } from "./events/routes.js";
import { publishChange, type ChangeEvent } from "./events/hub.js";
import { noteUrlSniffed } from "./events/watcher.js";

// Built web bundle (apps/web/dist), served on the same port when present.
const webDist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    // Hermes is meant to run behind a reverse proxy (Caddy/nginx). Trust its
    // X-Forwarded-For so `req.ip` is the real client — otherwise the login
    // rate-limiter and logs key on the proxy's single IP, which both blinds the
    // audit trail and lets one client's failures lock out everyone. When there
    // is no proxy (localhost), this is harmless: there's no XFF header to trust.
    trustProxy: true,
  });

  await app.register(cookie, { secret: getAuthSecret() });
  await app.register(cors, { origin: env.APP_ORIGIN, credentials: true });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 20 } });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "validation", issues: err.issues });
    }
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    const maybe = err as { statusCode?: number; message?: string };
    if (maybe.statusCode) {
      return reply.code(maybe.statusCode).send({ error: maybe.message ?? "error" });
    }
    app.log.error(err);
    return reply.code(500).send({ error: "internal error" });
  });

  /**
   * Security headers. The CSP is deliberately egress-focused: `img-src` and
   * `connect-src` are what stop an injected remote image (or a CSS `url(...)`)
   * from becoming a zero-click channel for smuggling data out of a page that
   * renders assistant- and calendar-feed-derived content.
   *
   * `script-src 'self'` is safe here — the production build emits no inline
   * scripts and the app loads no cross-origin assets (both verified against
   * apps/web/dist). `style-src` keeps 'unsafe-inline' because editor libraries
   * inject <style> elements at runtime.
   */
  app.addHook("onSend", async (_req, reply) => {
    reply.header(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
  });

  // Gate only the API before setup. Static assets and the SPA shell must always
  // load so the browser can render the setup wizard itself.
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0] ?? "";
    if (!path.startsWith("/api")) return; // static / SPA / health
    if (path.startsWith("/api/setup")) return; // setup always reachable
    if (!isDbReady()) {
      return reply.code(503).send({ error: "setup_required" });
    }
  });

  /**
   * Throttle credential endpoints. Registration is open and the instance is
   * internet-facing, so unlimited attempts meant unlimited password guessing.
   * Fixed-window counter per client IP — dependency-free and good enough to
   * turn brute force into a non-starter without inconveniencing a real user.
   */
  const hits = new Map<string, { n: number; resetAt: number }>();
  const RL_WINDOW_MS = 15 * 60 * 1000;
  const RL_MAX = 20;
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0] ?? "";
    if (path !== "/api/auth/login" && path !== "/api/auth/register") return;
    const now = Date.now();
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    const key = req.ip;
    const cur = hits.get(key);
    if (!cur || cur.resetAt <= now) {
      hits.set(key, { n: 1, resetAt: now + RL_WINDOW_MS });
      return;
    }
    cur.n += 1;
    if (cur.n > RL_MAX) {
      reply.header("Retry-After", String(Math.ceil((cur.resetAt - now) / 1000)));
      return reply.code(429).send({ error: "too many attempts — try again later" });
    }
  });

  // Fan out block mutations to the user's live-sync (SSE) connections. Runs at
  // the REST layer on a successful mutating request, so edits from the UI AND
  // from the AI assistant over MCP (which uses the loopback API) both broadcast.
  // Best-effort — never touches the response. `x-client-id` lets the causing tab
  // skip its own echo.
  app.addHook("onResponse", async (req, reply) => {
    if (reply.statusCode >= 300) return;
    const userId = req.userId;
    if (!userId || req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
    const ev = changeFor(req.method, req.url.split("?")[0] ?? "");
    if (!ev) return;
    const cid = req.headers["x-client-id"];
    if (typeof cid === "string") ev.origin = cid;
    publishChange(userId, ev);
    noteUrlSniffed(ev.id);
  });

  app.get("/health", async () => ({ ok: true }));

  // API under /api so it never collides with client-side routes (e.g. /settings).
  await app.register(setupRoutes, { prefix: "/api" });
  await app.register(authRoutes, { prefix: "/api" });
  await app.register(settingsRoutes, { prefix: "/api" });
  await app.register(backupRoutes, { prefix: "/api" });
  await app.register(exportRoutes, { prefix: "/api" });
  await app.register(adminRoutes, { prefix: "/api" });
  await app.register(eventRoutes, { prefix: "/api" });
  await app.register(blockTypeRoutes, { prefix: "/api" });
  await app.register(collectionRoutes, { prefix: "/api" });
  await app.register(todayRoutes, { prefix: "/api" });
  await app.register(reviewRoutes, { prefix: "/api" });
  await app.register(attachmentRoutes, { prefix: "/api" });
  await app.register(bannerRoutes, { prefix: "/api" });
  await app.register(calendarRoutes, { prefix: "/api" });
  await app.register(assistantRoutes, { prefix: "/api" });
  await app.register(blockRoutes, { prefix: "/api" });
  await app.register(mcpRoutes); // /mcp — no /api prefix
  await app.register(oauthRoutes); // /oauth/*, /.well-known/* — no /api prefix

  // Serve the web bundle + SPA fallback when it's been built.
  const staticEnabled = existsSync(webDist);
  if (staticEnabled) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "not found" });
    });
  } else {
    app.log.warn(`web bundle not found at ${webDist} — API only (run \`pnpm build\`)`);
  }

  return app;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// A block/collection endpoint (optionally a sub-action) → the affected id.
const BLOCK_RE = new RegExp(`^/api/blocks/(${UUID})(?:/(?:archive|unarchive|tags))?$`);
const COLL_RE = new RegExp(`^/api/collections/(${UUID})$`);
const COLL_MEMBERS_RE = new RegExp(`^/api/collections/${UUID}/members`);

/**
 * Map a successful mutating request to the change event to broadcast. A known
 * id targets that block (open cards/lists refetch it); an empty id means
 * "something was created/added — re-query lists" (the id isn't in the URL).
 * Returns null for requests that don't change a block.
 */
function changeFor(method: string, path: string): ChangeEvent | null {
  let m = path.match(BLOCK_RE);
  if (m) return { kind: method === "DELETE" ? "delete" : "block", id: m[1]! };
  m = path.match(COLL_RE);
  if (m) return { kind: method === "DELETE" ? "delete" : "block", id: m[1]! };
  if (COLL_MEMBERS_RE.test(path)) return { kind: "block", id: "" };
  if ((path === "/api/blocks" || path === "/api/collections") && method === "POST") {
    return { kind: "block", id: "" };
  }
  return null;
}
