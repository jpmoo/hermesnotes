import { randomInt } from "node:crypto";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isValidTimeZone } from "@hermes/shared";
import { apiTokens, devicePairings, users, userSettings } from "@hermes/db";
import { db } from "../db.js";
import { badRequest, conflict, forbidden, unauthorized } from "../lib/errors.js";
import { getAllowRegistration } from "../config.js";
import { generateToken, sha256 } from "../lib/hash.js";
import { seedBlockTypes } from "../blocks/seed.js";
import { seedWelcomeContent } from "../blocks/welcome.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import { issueSession, SESSION_COOKIE } from "./session.js";
import { authenticate, requireUser } from "./middleware.js";

const credentials = z.object({
  email: z.string().email(),
  password: z.string().min(8, "password must be at least 8 characters"),
  displayName: z.string().min(1).optional(),
  /**
   * Where the browser says it is, sent at sign-up. Day boundaries are decided
   * from this — which day a daily note belongs to, what counts as today for an
   * agent writing over MCP — and with nothing here the server falls back to its
   * own clock, which on a box running UTC is already tomorrow by the evening.
   * Asking at sign-up costs the user nothing; asking them to find the setting
   * costs them a bug first.
   */
  timezone: z.string().max(64).optional(),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const setSessionCookie = (
    reply: import("fastify").FastifyReply,
    userId: string,
    src: "password" | "key" = "password",
  ) => {
    const { value, maxAge } = issueSession(userId, src);
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
    const { email, password, displayName, timezone } = credentials.parse(req.body);
    // The first account always may register (bootstrap); after that, honour the
    // admin's public-registration toggle.
    if (!getAllowRegistration()) {
      const [row] = await db.select({ c: sql<number>`count(*)::int` }).from(users);
      if (Number(row?.c ?? 0) > 0) throw forbidden("registration is disabled");
    }
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
      // Inherit the instance-wide Ollama config from the admin's row (absent
      // for the very first signup — the admin configures it in Settings).
      const [adminRow] = await tx
        .select({
          ollamaUrl: userSettings.ollamaUrl,
          embedModel: userSettings.embedModel,
          embedDim: userSettings.embedDim,
          inferenceModel: userSettings.inferenceModel,
        })
        .from(userSettings)
        .innerJoin(users, eq(users.id, userSettings.userId))
        .where(eq(users.isAdmin, true))
        .limit(1);
      await tx.insert(userSettings).values({
        userId: id,
        ...(adminRow ?? {}),
        // A zone this runtime doesn't recognize is no better than none: leave it
        // null so the "which zone are you in" prompt still finds them.
        ...(isValidTimeZone(timezone) ? { timezone } : {}),
      });
      await seedBlockTypes(tx, id);
      return { userId: id, isAdmin: admin };
    });

    // Starter content ("Start here" spread + getting-started checklist).
    // Best-effort: a failure here must never block the signup.
    try {
      await seedWelcomeContent(db, userId);
    } catch (err) {
      req.log.warn({ err }, "welcome content seeding failed");
    }

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
    // Key-derived: this cookie is only as trusted as the access key, so it does
    // not grant the browser-only powers (e.g. hard-delete) a password login does.
    setSessionCookie(reply, row.ownerId, "key");

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

  /*
   * ── Pairing a device that has no keyboard worth typing a token on ─────────
   *
   * Three calls. The device starts a pairing and shows six digits; a signed-in
   * person types those into Hermes; the device, which has been polling all
   * along, collects the key once.
   *
   * **The code is not the secret and must never be treated as one.** Six digits
   * on a screen somebody may be holding up in a meeting cannot carry a key. The
   * secret is the pairing `id` — minted here, returned only to the device that
   * asked, and required to collect. The code exists so a person can say *which*
   * pending device they mean, and it is only ever read from an authenticated
   * session. An attacker who guesses a code learns nothing: they have no id to
   * collect with, and claiming needs a session that is not theirs.
   */

  /** How long a pairing is worth approving. Long enough to walk to a laptop. */
  const PAIR_TTL_MS = 10 * 60 * 1000;

  /** Rows nobody finished with. Swept opportunistically rather than on a timer:
   *  the only thing that cares is the uniqueness of a live code, and the only
   *  moment that matters is when a new one is being minted. */
  const sweepPairings = () =>
    db.delete(devicePairings).where(lt(devicePairings.expiresAt, new Date()));

  app.post("/auth/pair/start", async (req, reply) => {
    const { label } = z
      .object({ label: z.string().min(1).max(60).default("A device") })
      .parse(req.body ?? {});
    await sweepPairings();

    // `randomInt` rather than `Math.random`: this is short enough to guess at
    // scale already, and a predictable sequence would make that trivial rather
    // than merely possible. Retried on the unique index instead of checked
    // first, because checking and inserting are two statements and two devices
    // starting at once is exactly when they interleave.
    let row: { id: string; code: string } | undefined;
    for (let tries = 0; tries < 8 && !row; tries += 1) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      try {
        [row] = await db
          .insert(devicePairings)
          .values({ label, code, expiresAt: new Date(Date.now() + PAIR_TTL_MS) })
          .returning({ id: devicePairings.id, code: devicePairings.code });
      } catch {
        // Taken. Another go.
      }
    }
    if (!row) throw conflict("could not allocate a pairing code — try again");

    reply.code(201);
    return { deviceId: row.id, code: row.code, expiresInSeconds: PAIR_TTL_MS / 1000 };
  });

  /** What a person is being asked to approve, before they approve it. */
  app.get("/auth/pair/pending/:code", { preHandler: authenticate }, async (req) => {
    requireUser(req);
    const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.params);
    const [row] = await db
      .select({ label: devicePairings.label, createdAt: devicePairings.createdAt })
      .from(devicePairings)
      .where(
        and(
          eq(devicePairings.code, code),
          isNull(devicePairings.claimedAt),
          gt(devicePairings.expiresAt, new Date()),
        ),
      );
    if (!row) throw badRequest("no device is waiting with that code");
    return row;
  });

  app.post("/auth/pair/claim", { preHandler: authenticate }, async (req) => {
    const userId = requireUser(req);
    const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);

    const [pending] = await db
      .select({ id: devicePairings.id, label: devicePairings.label })
      .from(devicePairings)
      .where(
        and(
          eq(devicePairings.code, code),
          isNull(devicePairings.claimedAt),
          gt(devicePairings.expiresAt, new Date()),
        ),
      );
    if (!pending) throw badRequest("no device is waiting with that code");

    // The same kind of key as any other, from the same table, so revoking a
    // device is revoking a token and the list in Settings shows it beside the
    // rest. A second kind of credential would be a second thing to audit.
    const token = generateToken();
    const [made] = await db
      .insert(apiTokens)
      .values({ ownerId: userId, name: pending.label, tokenHash: sha256(token) })
      .returning({ id: apiTokens.id });

    // Claimed conditionally: two people approving the same code in the same
    // second must not both mint a key, and the loser's is revoked rather than
    // left live and forgotten.
    const [won] = await db
      .update(devicePairings)
      .set({ ownerId: userId, token, tokenId: made!.id, claimedAt: new Date() })
      .where(and(eq(devicePairings.id, pending.id), isNull(devicePairings.claimedAt)))
      .returning({ id: devicePairings.id });
    if (!won) {
      await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, made!.id));
      throw conflict("that code was just used");
    }

    return { paired: true, label: pending.label };
  });

  /**
   * Polled by the device. Unauthenticated, because the device has nothing to
   * authenticate with yet — the id it presents is the credential.
   */
  app.get("/auth/pair/:deviceId", async (req) => {
    const { deviceId } = z.object({ deviceId: z.string().uuid() }).parse(req.params);
    const [row] = await db
      .select({
        token: devicePairings.token,
        claimedAt: devicePairings.claimedAt,
        collectedAt: devicePairings.collectedAt,
        expiresAt: devicePairings.expiresAt,
      })
      .from(devicePairings)
      .where(eq(devicePairings.id, deviceId));

    if (!row) return { status: "unknown" };
    if (row.collectedAt) return { status: "spent" };
    if (!row.claimedAt) {
      return row.expiresAt < new Date() ? { status: "expired" } : { status: "waiting" };
    }

    // Handed over exactly once. Cleared in the same statement that reports it,
    // and only if it is still there — so two polls arriving together cannot
    // both come back holding a key.
    const [taken] = await db
      .update(devicePairings)
      .set({ token: null, collectedAt: new Date() })
      .where(and(eq(devicePairings.id, deviceId), isNull(devicePairings.collectedAt)))
      .returning({ id: devicePairings.id });
    if (!taken) return { status: "spent" };
    return { status: "paired", token: row.token };
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
