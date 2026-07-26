import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { userSettings } from "@hermes/db";
import { db } from "../db.js";
import { env } from "../env.js";
import { badRequest } from "../lib/errors.js";
import { authenticate, requireUser } from "../auth/middleware.js";
import { Api, type ApiAuth } from "../mcp/api.js";
import { runAgent } from "./agent.js";

export async function assistantRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

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

    const authHeader = req.headers.authorization;
    const auth: ApiAuth =
      authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : { cookie: req.headers.cookie ?? "" };
    const api = new Api(`http://127.0.0.1:${env.PORT}/api`, auth);

    const result = await runAgent({
      url: settings.url,
      model: settings.model,
      api,
      messages: body.messages,
    });
    return result;
  });
}
