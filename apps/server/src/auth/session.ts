import { createHmac, timingSafeEqual } from "node:crypto";
import { getAuthSecret } from "../config.js";

/**
 * Stateless signed-cookie sessions. The cookie value is
 * `base64url(json).base64url(hmac)`. No server-side session store — fine for a
 * single-server deployment. Bearer API tokens are handled separately.
 */
export const SESSION_COOKIE = "hermes_session";
const MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30 days

interface Payload {
  userId: string;
  exp: number; // unix seconds
}

function sign(data: string): string {
  return createHmac("sha256", getAuthSecret()).update(data).digest("base64url");
}

export function issueSession(userId: string): { value: string; maxAge: number } {
  const payload: Payload = { userId, exp: Math.floor(Date.now() / 1000) + MAX_AGE_SEC };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return { value: `${body}.${sign(body)}`, maxAge: MAX_AGE_SEC };
}

export function readSession(cookie: string | undefined): string | null {
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
    return payload.userId;
  } catch {
    return null;
  }
}
