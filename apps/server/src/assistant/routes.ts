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
import { appendMessage, buildContext, clearThread, loadThread, maybeSummarize, modelContext } from "./store.js";

export async function assistantRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  const apiFor = (req: Parameters<typeof requireUser>[0]): Api => {
    const authHeader = req.headers.authorization;
    const auth: ApiAuth =
      authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : { cookie: req.headers.cookie ?? "" };
    return new Api(`http://127.0.0.1:${env.PORT}/api`, auth);
  };

  const requireModel = async (userId: string) => {
    const [settings] = await db
      .select({ url: userSettings.ollamaUrl, model: userSettings.inferenceModel })
      .from(userSettings)
      .where(eq(userSettings.userId, userId))
      .limit(1);
    if (!settings?.url) throw badRequest("No Ollama URL configured for this instance.");
    if (!settings.model)
      throw badRequest("No inference model set. Choose a tool-capable model (e.g. llama3.1, qwen2.5) in Settings.");
    return { url: settings.url, model: settings.model };
  };

  /** The persisted conversation (for hydrating the panel on load). */
  app.get("/assistant/messages", async (req) => {
    const userId = requireUser(req);
    const thread = await loadThread(userId);
    return {
      messages: thread.messages.map((m) => ({ role: m.role, content: m.content, steps: m.steps ?? undefined })),
      summarized: thread.summary !== null,
    };
  });

  /** Wipe the conversation — zeroes the context the next turn is built from. */
  app.delete("/assistant/messages", async (req) => {
    const userId = requireUser(req);
    await clearThread(userId);
    return { ok: true };
  });

  /**
   * Run one turn of the in-app assistant. History is server-authoritative: the
   * client sends only the new user message, we rebuild context from the stored
   * thread (rolling summary + recent turns), persist both sides, and fold older
   * turns into the summary when the prompt nears the model's context window.
   *
   * Tool calls act as the requester — we forward the caller's own auth (session
   * cookie or bearer key) to the loopback API, so ownership/permissions match.
   */
  app.post("/assistant/chat", async (req) => {
    const userId = requireUser(req);
    const body = z.object({ message: z.string().min(1) }).parse(req.body);
    const { url, model } = await requireModel(userId);

    await appendMessage(userId, "user", body.message);
    const thread = await loadThread(userId);
    const numCtx = await modelContext(url, model);

    const result = await runAgent({
      url,
      model,
      api: apiFor(req),
      messages: buildContext(thread),
      confirmDestructive: true,
      numCtx,
    });

    // Persist the assistant's reply (pending destructive calls stay transient —
    // they're resolved via /confirm, which persists their outcome).
    await appendMessage(userId, "assistant", result.reply, result.steps);
    await maybeSummarize({ userId, url, model, numCtx, promptTokens: result.promptTokens ?? 0 });
    return { reply: result.reply, steps: result.steps, pending: result.pending };
  });

  /** Execute the destructive calls the user just approved in the panel. */
  app.post("/assistant/confirm", async (req) => {
    const userId = requireUser(req);
    const body = z
      .object({
        calls: z.array(z.object({ tool: z.string(), args: z.unknown() })).min(1),
      })
      .parse(req.body);
    const result = await runConfirmed({ api: apiFor(req), calls: body.calls });
    await appendMessage(userId, "assistant", "Done.", result.steps);
    return result;
  });
}
