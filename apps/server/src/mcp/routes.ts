import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { env } from "../env.js";
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
    if (!token) {
      // The WWW-Authenticate header lets OAuth-only MCP clients (claude.ai
      // connectors) discover our authorization server and start the flow.
      return reply
        .code(401)
        .header("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl()}"`)
        .send({ error: "Missing Authorization: Bearer <hermes access key>" });
    }
    const server = new McpServer({ name: "hermes", version: "1.0.0" });
    buildTools(server, new Api(`http://127.0.0.1:${env.PORT}/api`, token));
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

  // Stateless server: only POST is meaningful.
  const reject = async (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) =>
    reply.code(405).send({ error: "POST only (stateless MCP endpoint)" });
  app.get("/mcp", reject);
  app.delete("/mcp", reject);
}
