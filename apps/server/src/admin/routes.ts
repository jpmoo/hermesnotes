import { asc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { blocks, users } from "@hermes/db";
import { db } from "../db.js";
import { getAllowRegistration, saveAllowRegistration } from "../config.js";
import { hashPassword } from "../auth/passwords.js";
import { authenticate, requireAdmin } from "../auth/middleware.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";

/** The bootstrap admin — the oldest account — can never be deleted. */
async function firstAdminId(): Promise<string | null> {
  const [row] = await db.select({ id: users.id }).from(users).orderBy(asc(users.createdAt)).limit(1);
  return row?.id ?? null;
}

/** Admin-only: the public-registration toggle and user management. */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  app.get("/admin/registration", async (req) => {
    await requireAdmin(req);
    return { allowRegistration: getAllowRegistration() };
  });

  app.put("/admin/registration", async (req) => {
    await requireAdmin(req);
    const { allowRegistration } = z.object({ allowRegistration: z.boolean() }).parse(req.body);
    await saveAllowRegistration(allowRegistration);
    return { allowRegistration };
  });

  /** Every account, with a block count, newest last. */
  app.get("/admin/users", async (req) => {
    await requireAdmin(req);
    const counts = await db
      .select({ ownerId: blocks.ownerId, n: sql<number>`count(*)::int` })
      .from(blocks)
      .groupBy(blocks.ownerId);
    const countBy = new Map(counts.map((c) => [c.ownerId, c.n]));
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        isAdmin: users.isAdmin,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(asc(users.createdAt));
    const firstAdmin = rows[0]?.id ?? null;
    return {
      users: rows.map((u) => ({
        ...u,
        blockCount: countBy.get(u.id) ?? 0,
        protected: u.id === firstAdmin, // the bootstrap admin can't be deleted
      })),
    };
  });

  /** Admin sets a user's password (a reset — the user isn't asked for the old one). */
  app.post("/admin/users/:id/password", async (req) => {
    await requireAdmin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { password } = z
      .object({ password: z.string().min(8, "password must be at least 8 characters") })
      .parse(req.body);
    const [target] = await db.select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1);
    if (!target) throw notFound("user");
    await db.update(users).set({ passwordHash: await hashPassword(password), updatedAt: new Date() }).where(eq(users.id, id));
    return { ok: true };
  });

  /** Delete a user and (via ON DELETE CASCADE) all of their data. */
  app.delete("/admin/users/:id", async (req) => {
    const adminId = await requireAdmin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (id === adminId) throw badRequest("you can't delete your own account here");
    if (id === (await firstAdminId())) throw forbidden("the first admin account can't be deleted");
    const [gone] = await db.delete(users).where(eq(users.id, id)).returning({ id: users.id });
    if (!gone) throw notFound("user");
    return { ok: true };
  });
}
