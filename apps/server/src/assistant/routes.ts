import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { userSettings } from "@hermes/db";
import { db } from "../db.js";
import { env } from "../env.js";
import { badRequest } from "../lib/errors.js";
import { authenticate, requireUser } from "../auth/middleware.js";
import { Api, type ApiAuth } from "../mcp/api.js";
import { runAgent, runConfirmed } from "./agent.js";

export async function assistantRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  const apiFor = (req: Parameters<typeof requireUser>[0]): Api => {
    const authHeader = req.headers.authorization;
    const auth: ApiAuth =
      authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : { cookie: req.headers.cookie ?? "" };
    return new Api(`http://127.0.0.1:${env.PORT}/api`, auth);
  };

  /**
   * Run the in-app assistant. The tool calls it makes act as the requester —
   * we forward the caller's own auth (session cookie or bearer key) to the
   * loopback API, so ownership/permissions are identical to the user's.
   */
  app.post("/assistant/chat", async (req) => {
    const userId = requireUser(req);
    const body = z
      .object({
        messages: z
          .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
          .min(1),
      })
      .parse(req.body);

    const [settings] = await db
      .select({ url: userSettings.ollamaUrl, model: userSettings.inferenceModel })
      .from(userSettings)
      .where(eq(userSettings.userId, userId))
      .limit(1);
    if (!settings?.url) throw badRequest("No Ollama URL configured for this instance.");
    if (!settings.model)
      throw badRequest("No inference model set. Choose a tool-capable model (e.g. llama3.1, qwen2.5) in Settings.");

    const result = await runAgent({
      url: settings.url,
      model: settings.model,
      api: apiFor(req),
      messages: body.messages,
      confirmDestructive: true,
    });
    return result;
  });

  /** Execute the destructive calls the user just approved in the panel. */
  app.post("/assistant/confirm", async (req) => {
    requireUser(req);
    const body = z
      .object({
        calls: z.array(z.object({ tool: z.string(), args: z.unknown() })).min(1),
      })
      .parse(req.body);
    return runConfirmed({ api: apiFor(req), calls: body.calls });
  });
}
