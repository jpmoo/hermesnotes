import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { apiTokens, users, userSettings } from "@hermes/db";
import { db } from "../db.js";
import { badRequest, conflict, unauthorized } from "../lib/errors.js";
import { generateToken, sha256 } from "../lib/hash.js";
import { seedBlockTypes } from "../blocks/seed.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import { issueSession, SESSION_COOKIE } from "./session.js";
import { authenticate, requireUser } from "./middleware.js";

const credentials = z.object({
  email: z.string().email(),
  password: z.string().min(8, "password must be at least 8 characters"),
  displayName: z.string().min(1).optional(),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const setSessionCookie = (reply: import("fastify").FastifyReply, userId: string) => {
    const { value, maxAge } = issueSession(userId);
    reply.setCookie(SESSION_COOKIE, value, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge,
    });
  };

  // Open self-serve signup.
  app.post("/auth/register", async (req, reply) => {
    const { email, password, displayName } = credentials.parse(req.body);
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (existing.length) throw conflict("email already registered");

    const passwordHash = await hashPassword(password);
    const { userId, isAdmin } = await db.transaction(async (tx) => {
      // The first account to register becomes the admin.
      const counted = await tx.select({ count: sql<number>`count(*)::int` }).from(users);
      const admin = (counted[0]?.count ?? 0) === 0;
      const [row] = await tx
        .insert(users)
        .values({ email, passwordHash, displayName: displayName ?? null, isAdmin: admin })
        .returning({ id: users.id });
      const id = row!.id;
      await tx.insert(userSettings).values({ userId: id });
      await seedBlockTypes(tx, id);
      return { userId: id, isAdmin: admin };
    });

    setSessionCookie(reply, userId);
    reply.code(201);
    return { id: userId, email, displayName: displayName ?? null, isAdmin };
  });

  app.post("/auth/login", async (req, reply) => {
    const { email, password } = credentials.omit({ displayName: true }).parse(req.body);
    const [user] = await db
      .select({
        id: users.id,
        passwordHash: users.passwordHash,
        displayName: users.displayName,
        isAdmin: users.isAdmin,
      })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (!user || !(await verifyPassword(user.passwordHash, password))) {
      throw unauthorized("invalid email or password");
    }
    setSessionCookie(reply, user.id);
    return { id: user.id, email, displayName: user.displayName, isAdmin: user.isAdmin };
  });

  app.post("/auth/logout", async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  /**
   * Exchange an access key (an api_token) for a session cookie. The web client
   * calls this with a key carried in the URL fragment, then strips it — so the
   * key never lands in server logs or history. Same store as bearer tokens.
   */
  app.post("/auth/exchange", async (req, reply) => {
    const { key } = z.object({ key: z.string().min(1) }).parse(req.body);
    const [row] = await db
      .select({ ownerId: apiTokens.ownerId, id: apiTokens.id })
      .from(apiTokens)
      .where(and(eq(apiTokens.tokenHash, sha256(key)), isNull(apiTokens.revokedAt)))
      .limit(1);
    if (!row) throw unauthorized("invalid or revoked access key");

    await db
      .update(apiTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiTokens.id, row.id));
    setSessionCookie(reply, row.ownerId);

    const [user] = await db
      .select({ id: users.id, email: users.email, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, row.ownerId))
      .limit(1);
    if (!user) throw unauthorized();
    return user;
  });

  app.get("/auth/me", { preHandler: authenticate }, async (req) => {
    const userId = requireUser(req);
    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        isAdmin: users.isAdmin,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) throw unauthorized();
    return user;
  });

  // ── API tokens (for future programmatic / MCP access) ────────────────
  app.get("/auth/tokens", { preHandler: authenticate }, async (req) => {
    const userId = requireUser(req);
    return db
      .select({
        id: apiTokens.id,
        name: apiTokens.name,
        lastUsedAt: apiTokens.lastUsedAt,
        createdAt: apiTokens.createdAt,
      })
      .from(apiTokens)
      .where(and(eq(apiTokens.ownerId, userId), isNull(apiTokens.revokedAt)));
  });

  app.post("/auth/tokens", { preHandler: authenticate }, async (req, reply) => {
    const userId = requireUser(req);
    const { name } = z.object({ name: z.string().min(1) }).parse(req.body);
    const token = generateToken();
    const [row] = await db
      .insert(apiTokens)
      .values({ ownerId: userId, name, tokenHash: sha256(token) })
      .returning({ id: apiTokens.id });
    reply.code(201);
    // The plaintext token is returned exactly once.
    return { id: row!.id, name, token };
  });

  app.delete("/auth/tokens/:id", { preHandler: authenticate }, async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const res = await db
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiTokens.id, id), eq(apiTokens.ownerId, userId)))
      .returning({ id: apiTokens.id });
    if (!res.length) throw badRequest("token not found");
    return { ok: true };
  });
}
