import type { FastifyInstance } from "fastify";
import { authenticate, requireUser } from "../auth/middleware.js";
import { subscribeChanges, type ChangeEvent } from "./hub.js";
import { noteListenerClosed, noteListenerOpened } from "./watcher.js";

/**
 * Server-Sent Events: a per-user stream of block-change events so open surfaces
 * (an editing card, a list, a smart collection) refresh when the same block is
 * changed elsewhere — another tab, another device, or the AI assistant over MCP.
 * Read-only; the browser's EventSource sends the session cookie automatically.
 */
export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  app.get("/events", (req, reply) => {
    const userId = requireUser(req);
    // Take over the socket — Fastify won't send its own response.
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Tell an nginx-style proxy not to buffer the stream (Caddy already streams).
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");

    const send = (ev: ChangeEvent) => {
      // Best-effort; a write to a closed socket just no-ops after cleanup.
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    const unsubscribe = subscribeChanges(userId, send);
    // The watcher reads the change log only while somebody is listening.
    noteListenerOpened();
    // Comment ping keeps idle proxies from dropping the connection.
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);

    let done = false;
    const cleanup = () => {
      if (done) return; // close and error can both fire
      done = true;
      clearInterval(ping);
      unsubscribe();
      noteListenerClosed();
    };
    req.raw.on("close", cleanup);
    res.on("error", cleanup);
  });
}
