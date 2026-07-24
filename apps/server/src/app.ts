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
import { attachmentRoutes } from "./attachments/routes.js";
import { bannerRoutes } from "./banners/routes.js";
import { setupRoutes } from "./setup/routes.js";
import { backupRoutes } from "./backup/routes.js";

// Built web bundle (apps/web/dist), served on the same port when present.
const webDist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
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

  app.get("/health", async () => ({ ok: true }));

  // API under /api so it never collides with client-side routes (e.g. /settings).
  await app.register(setupRoutes, { prefix: "/api" });
  await app.register(authRoutes, { prefix: "/api" });
  await app.register(settingsRoutes, { prefix: "/api" });
  await app.register(backupRoutes, { prefix: "/api" });
  await app.register(blockTypeRoutes, { prefix: "/api" });
  await app.register(collectionRoutes, { prefix: "/api" });
  await app.register(todayRoutes, { prefix: "/api" });
  await app.register(attachmentRoutes, { prefix: "/api" });
  await app.register(bannerRoutes, { prefix: "/api" });
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
