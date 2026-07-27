import { and, eq, isNull } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { apiTokens, users } from "@hermes/db";
import { db } from "../db.js";
import { sha256 } from "../lib/hash.js";
import { forbidden, unauthorized } from "../lib/errors.js";
import { readSession, SESSION_COOKIE } from "./session.js";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
    /** How the request authenticated: a browser session, or a bearer API key. */
    authKind?: "cookie" | "bearer";
  }
}

/**
 * Resolve the request to an owner. Accepts either a signed session cookie
 * (browser) or `Authorization: Bearer <token>` (programmatic). Attaches
 * `request.userId`. Throws 401 when neither is valid.
 */
export async function authenticate(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  // Bearer token first.
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    const [row] = await db
      .select({ ownerId: apiTokens.ownerId, id: apiTokens.id })
      .from(apiTokens)
      .where(and(eq(apiTokens.tokenHash, sha256(token)), isNull(apiTokens.revokedAt)))
      .limit(1);
    if (row) {
      req.userId = row.ownerId;
      req.authKind = "bearer";
      // best-effort last-used stamp; don't block the request on it
      void db
        .update(apiTokens)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiTokens.id, row.id))
        .execute()
        .catch(() => {});
      return;
    }
  }

  // Session cookie.
  const cookie = req.cookies?.[SESSION_COOKIE];
  const userId = readSession(cookie);
  if (userId) {
    req.userId = userId;
    req.authKind = "cookie";
    return;
  }

  throw unauthorized();
}

/** Convenience for handlers: asserts and returns the owner id. */
export function requireUser(req: FastifyRequest): string {
  if (!req.userId) throw unauthorized();
  return req.userId;
}

/** Asserts the requester is an admin user; returns the user id. */
export async function requireAdmin(req: FastifyRequest): Promise<string> {
  const userId = requireUser(req);
  const [row] = await db
    .select({ isAdmin: users.isAdmin })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row?.isAdmin) throw forbidden("admin only");
  return userId;
}
