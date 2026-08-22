import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { env } from "../env.js";
import { ownerForBearer } from "../auth/middleware.js";
import { resourceMetadataUrl } from "../auth/oauth.js";
import { Api } from "./api.js";
import { buildTools } from "./toolkit.js";

/**
 * MCP endpoint mounted on the app server itself: POST /mcp (no /api prefix, so
 * the public URL is just <app>/mcp behind the same reverse-proxy entry).
 * Stateless streamable HTTP: each request builds a server bound to the
 * caller's bearer key, which is forwarded to our own API over loopback — so
 * auth, ownership, and revocation are exactly the API-token semantics.
 */
export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  app.post("/mcp", async (req, reply) => {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    // The WWW-Authenticate header lets OAuth-only MCP clients (claude.ai
    // connectors) discover our authorization server and start the flow.
    const challenge = (message: string) =>
      reply
        .code(401)
        .header("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl()}"`)
        .send({ error: message });
    if (!token) return challenge("Missing Authorization: Bearer <hermes access key>");
    // The key is checked here rather than left to the loopback call it's about
    // to be forwarded on. Accepting any non-empty string meant a revoked or
    // expired key still completed a handshake and still answered tools/list in
    // full, then failed on the first tool call with a 401 from somewhere the
    // client couldn't see — which reads as a broken client rather than a dead
    // key, and never gave an OAuth client the challenge it needed to refresh.
    if (!(await ownerForBearer(token))) {
      return challenge("Invalid or revoked access key — mint a new one under Settings → Access keys.");
    }
    // The SDK 406s any POST whose Accept doesn't list BOTH application/json
    // and text/event-stream — but with enableJsonResponse we answer plain JSON
    // regardless, so that strictness only breaks simple clients (curl, custom
    // agents sending "Accept: application/json" or "*/*"). Normalize it away.
    const accept = String(req.raw.headers.accept ?? "");
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
      req.raw.headers.accept = "application/json, text/event-stream";
    }
    const server = new McpServer({ name: "hermes", version: "1.0.0" });
    await buildTools(server, new Api(`http://127.0.0.1:${env.PORT}/api`, token));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  // Stateless server: only POST is meaningful. A GET here is usually a client
  // configured for the legacy HTTP+SSE transport — say so, so the failure is
  // self-diagnosing.
  const reject = async (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) =>
    reply.code(405).send({
      error:
        "This is a streamable-HTTP MCP endpoint: POST JSON-RPC to this URL with " +
        "Authorization: Bearer <hermes access key>. The legacy SSE transport (GET) is not supported — " +
        "configure your client for 'streamable http'.",
    });
  app.get("/mcp", reject);
  app.delete("/mcp", reject);
}
