import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { env } from "./env.js";
import { getAuthSecret } from "./config.js";
import { isDbReady } from "./db.js";
import { HttpError } from "./lib/errors.js";
import { authRoutes } from "./auth/routes.js";
import { settingsRoutes } from "./settings/routes.js";
import { blockRoutes } from "./blocks/routes.js";
import { setupRoutes } from "./setup/routes.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
  });

  await app.register(cookie, { secret: getAuthSecret() });
  await app.register(cors, { origin: env.APP_ORIGIN, credentials: true });

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

  // Until the database is configured, only setup + health are reachable.
  app.addHook("onRequest", async (req, reply) => {
    const url = req.url.split("?")[0] ?? "";
    if (url === "/health" || url.startsWith("/setup")) return;
    if (!isDbReady()) {
      return reply.code(503).send({ error: "setup_required" });
    }
  });

  app.get("/health", async () => ({ ok: true }));

  await app.register(setupRoutes);
  await app.register(authRoutes);
  await app.register(settingsRoutes);
  await app.register(blockRoutes);

  return app;
}
