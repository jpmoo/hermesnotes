import { runMigrations, users } from "@hermes/db";
import { count } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, isDbReady } from "../db.js";
import { getAllowRegistration, saveDatabaseUrl } from "../config.js";
import { conflict } from "../lib/errors.js";
import { provisionDatabase } from "./pg-admin.js";

const identifier = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be a valid PostgreSQL identifier");

const setupBody = z.object({
  admin: z.object({
    host: z.string().default("localhost"),
    port: z.coerce.number().default(5432),
    user: z.string().default("postgres"),
    password: z.string(),
    database: z.string().default("postgres"),
    ssl: z.boolean().optional(),
  }),
  app: z.object({
    dbName: identifier.default("hermes"),
    user: identifier.default("hermes"),
    password: z.string().min(1),
    host: z.string().optional(), // defaults to admin.host
    port: z.coerce.number().optional(), // defaults to admin.port
  }),
});

export async function setupRoutes(app: FastifyInstance): Promise<void> {
  // Reports what the first-run wizard still needs. Always available.
  app.get("/setup/status", async () => {
    if (!isDbReady()) return { configured: false, hasUsers: false, allowRegistration: true };
    try {
      const [row] = await db.select({ c: count() }).from(users);
      const hasUsers = Number(row?.c ?? 0) > 0;
      // Registration is open when the admin allows it, and always before the
      // first account exists (so the instance can be bootstrapped).
      return { configured: true, hasUsers, allowRegistration: getAllowRegistration() || !hasUsers };
    } catch {
      // DB configured but not migrated yet — treat as needing setup completion.
      return { configured: false, hasUsers: false, allowRegistration: true };
    }
  });

  // Provision Postgres, migrate, and connect the live pool. Locked once ready.
  app.post("/setup/database", async (req, reply) => {
    if (isDbReady()) throw conflict("already configured");
    const body = setupBody.parse(req.body);

    const url = await provisionDatabase(
      {
        host: body.admin.host,
        port: body.admin.port,
        user: body.admin.user,
        password: body.admin.password,
        database: body.admin.database,
        ssl: body.admin.ssl,
      },
      {
        host: body.app.host ?? body.admin.host,
        port: body.app.port ?? body.admin.port,
        dbName: body.app.dbName,
        user: body.app.user,
        password: body.app.password,
      },
    );

    await runMigrations(url);
    await saveDatabaseUrl(url);

    reply.code(201);
    return { ok: true };
  });
}
