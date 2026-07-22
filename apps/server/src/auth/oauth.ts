import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { apiTokens } from "@hermes/db";
import { db } from "../db.js";
import { env } from "../env.js";
import { generateToken, sha256 } from "../lib/hash.js";
import { readSession, SESSION_COOKIE } from "./session.js";

/**
 * Minimal OAuth 2.1 authorization server so MCP clients that only speak OAuth
 * (claude.ai custom connectors, Claude mobile) can connect. The flow ends by
 * minting a regular Hermes access key for the logged-in user, so the MCP
 * endpoint's bearer auth is unchanged and revocation stays in Settings.
 *
 * Endpoints (registered WITHOUT the /api prefix — public paths ride the same
 * reverse-proxy entry as the app):
 *   /.well-known/oauth-protected-resource[<path>]  — RFC 9728 (path-inserted)
 *   /.well-known/oauth-authorization-server[<path>] — RFC 8414
 *   /oauth/register  — RFC 7591 dynamic client registration (open, stateless)
 *   /oauth/authorize — consent page (requires the app session cookie)
 *   /oauth/approve   — consent form target → redirects with the code
 *   /oauth/token     — code + PKCE → a fresh Hermes access key
 *
 * PUBLIC_BASE (env) must be the app's public URL including any subpath, e.g.
 * https://app.example.com/hermesnotes — metadata URLs are absolute.
 */

const CODE_TTL_MS = 5 * 60 * 1000;
const codes = new Map<
  string,
  { userId: string; challenge: string; redirectUri: string; clientId: string; exp: number }
>();

const publicBase = (): string => (env.PUBLIC_BASE ?? `http://localhost:${env.PORT}`).replace(/\/$/, "");

/** The RFC 9728 resource-metadata URL for our /mcp resource. */
export function resourceMetadataUrl(): string {
  const base = new URL(publicBase());
  return `${base.origin}/.well-known/oauth-protected-resource${base.pathname === "/" ? "" : base.pathname}/mcp`;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function oauthRoutes(app: FastifyInstance): Promise<void> {
  // OAuth posts are form-encoded; parse them for this plugin's routes only.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  });

  const protectedResource = () => ({
    resource: `${publicBase()}/mcp`,
    authorization_servers: [publicBase()],
    bearer_methods_supported: ["header"],
  });
  const authServer = () => ({
    issuer: publicBase(),
    authorization_endpoint: `${publicBase()}/oauth/authorize`,
    token_endpoint: `${publicBase()}/oauth/token`,
    registration_endpoint: `${publicBase()}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["hermes"],
  });
  // Clients build these URLs by inserting the well-known segment before the
  // resource path (RFC 9728 §3.1) — accept both the bare and suffixed forms.
  app.get("/.well-known/oauth-protected-resource", async () => protectedResource());
  app.get("/.well-known/oauth-protected-resource/*", async () => protectedResource());
  app.get("/.well-known/oauth-authorization-server", async () => authServer());
  app.get("/.well-known/oauth-authorization-server/*", async () => authServer());

  app.post("/oauth/register", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    reply.code(201);
    return {
      client_id: randomUUID(),
      redirect_uris: Array.isArray(body.redirect_uris) ? body.redirect_uris : [],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      client_name: typeof body.client_name === "string" ? body.client_name : "MCP client",
    };
  });

  const authorizeQuery = z.object({
    response_type: z.literal("code"),
    client_id: z.string().min(1),
    redirect_uri: z.string().url(),
    state: z.string().optional(),
    code_challenge: z.string().min(1),
    code_challenge_method: z.literal("S256"),
    scope: z.string().optional(),
  });

  const redirectOk = (uri: string) =>
    uri.startsWith("https://") || uri.startsWith("http://localhost") || uri.startsWith("http://127.0.0.1");

  app.get("/oauth/authorize", async (req, reply) => {
    const q = authorizeQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send("Invalid authorization request.");
    if (!redirectOk(q.data.redirect_uri)) return reply.code(400).send("Unsupported redirect_uri.");
    const userId = readSession(req.cookies?.[SESSION_COOKIE]);
    reply.type("text/html");
    if (!userId) {
      return `<!doctype html><meta charset="utf-8"><title>Hermes — sign in required</title>
<body style="font-family:sans-serif;max-width:480px;margin:80px auto;line-height:1.5">
<h2>Sign in to Hermes first</h2>
<p>This browser isn't signed in to Hermes Notes. <a href="${esc(publicBase())}/" target="_blank">Open Hermes</a>,
sign in, then come back here and <a href="javascript:location.reload()">retry</a>.</p></body>`;
    }
    const fields = Object.entries({
      client_id: q.data.client_id,
      redirect_uri: q.data.redirect_uri,
      state: q.data.state ?? "",
      code_challenge: q.data.code_challenge,
    })
      .map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`)
      .join("");
    const deny = `${q.data.redirect_uri}${q.data.redirect_uri.includes("?") ? "&" : "?"}error=access_denied${
      q.data.state ? `&state=${encodeURIComponent(q.data.state)}` : ""
    }`;
    return `<!doctype html><meta charset="utf-8"><title>Authorize access to Hermes</title>
<body style="font-family:sans-serif;max-width:480px;margin:80px auto;line-height:1.5">
<h2>Allow this app to access your Hermes Notes?</h2>
<p>It will get a Hermes access key (visible under Settings → Access keys as
“Claude connector”) with full access to your notes and tasks. You can revoke it
there at any time.</p>
<form method="post" action="${esc(publicBase())}/oauth/approve">${fields}
<button type="submit" style="padding:10px 22px;font-size:15px">Approve</button>
<a href="${esc(deny)}" style="margin-left:16px">Deny</a></form></body>`;
  });

  app.post("/oauth/approve", async (req, reply) => {
    const body = z
      .object({
        client_id: z.string().min(1),
        redirect_uri: z.string().url(),
        state: z.string().optional(),
        code_challenge: z.string().min(1),
      })
      .parse(req.body);
    if (!redirectOk(body.redirect_uri)) return reply.code(400).send("Unsupported redirect_uri.");
    const userId = readSession(req.cookies?.[SESSION_COOKIE]);
    if (!userId) return reply.code(401).send("Session expired — reload the authorize page.");
    const code = randomUUID();
    codes.set(code, {
      userId,
      challenge: body.code_challenge,
      redirectUri: body.redirect_uri,
      clientId: body.client_id,
      exp: Date.now() + CODE_TTL_MS,
    });
    const sep = body.redirect_uri.includes("?") ? "&" : "?";
    const state = body.state ? `&state=${encodeURIComponent(body.state)}` : "";
    return reply.redirect(`${body.redirect_uri}${sep}code=${code}${state}`, 302);
  });

  app.post("/oauth/token", async (req, reply) => {
    const body = z
      .object({
        grant_type: z.literal("authorization_code"),
        code: z.string().min(1),
        code_verifier: z.string().min(1),
        redirect_uri: z.string().optional(),
        client_id: z.string().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const entry = codes.get(body.data.code);
    codes.delete(body.data.code);
    if (!entry || entry.exp < Date.now()) return reply.code(400).send({ error: "invalid_grant" });
    if (body.data.redirect_uri && body.data.redirect_uri !== entry.redirectUri)
      return reply.code(400).send({ error: "invalid_grant" });
    const digest = createHash("sha256").update(body.data.code_verifier).digest("base64url");
    if (digest !== entry.challenge) return reply.code(400).send({ error: "invalid_grant" });

    // The access token IS a regular Hermes access key — Settings can revoke it.
    const token = generateToken();
    await db.insert(apiTokens).values({
      ownerId: entry.userId,
      name: `Claude connector (${new Date().toISOString().slice(0, 10)})`,
      tokenHash: sha256(token),
    });
    return { access_token: token, token_type: "Bearer", scope: "hermes" };
  });
}
