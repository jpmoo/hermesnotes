import { createHmac, timingSafeEqual } from "node:crypto";
import { getAuthSecret } from "../config.js";

/**
 * Stateless signed-cookie sessions. The cookie value is
 * `base64url(json).base64url(hmac)`. No server-side session store — fine for a
 * single-server deployment. Bearer API tokens are handled separately.
 */
export const SESSION_COOKIE = "hermes_session";
const MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30 days

/**
 * How the session was obtained. A "password" session came from an interactive
 * login/registration; a "key" session was minted by exchanging an access key
 * (`/auth/exchange`) and is therefore only as trustworthy as that key — so the
 * few browser-only, irreversible actions (e.g. hard-delete) treat it like a
 * bearer token rather than a full browser login.
 */
export type SessionSource = "password" | "key";

interface Payload {
  userId: string;
  exp: number; // unix seconds
  src?: "key"; // omitted for password logins (keeps older cookies valid = password)
}

function sign(data: string): string {
  return createHmac("sha256", getAuthSecret()).update(data).digest("base64url");
}

export function issueSession(
  userId: string,
  src: SessionSource = "password",
): { value: string; maxAge: number } {
  const payload: Payload = { userId, exp: Math.floor(Date.now() / 1000) + MAX_AGE_SEC };
  if (src === "key") payload.src = "key";
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return { value: `${body}.${sign(body)}`, maxAge: MAX_AGE_SEC };
}

export function readSession(
  cookie: string | undefined,
): { userId: string; src: SessionSource } | null {
  if (!cookie) return null;
  const [body, mac] = cookie.split(".");
  if (!body || !mac) return null;
  const expected = sign(body);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Payload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return { userId: payload.userId, src: payload.src === "key" ? "key" : "password" };
  } catch {
    return null;
  }
}
