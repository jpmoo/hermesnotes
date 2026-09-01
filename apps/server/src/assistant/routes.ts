import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { userLocalNow } from "@hermes/shared";
import { userSettings } from "@hermes/db";
import { db } from "../db.js";
import { env } from "../env.js";
import { badRequest } from "../lib/errors.js";
import { authenticate, requireUser } from "../auth/middleware.js";
import { Api, ApiError, type ApiAuth } from "../mcp/api.js";
import { runAgent, runConfirmed } from "./agent.js";
import { appendMessage, buildContext, clearThread, loadThread, maybeSummarize, modelContext } from "./store.js";
import { effectiveTimeZone } from "../lib/timezone.js";

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
      .select({
        url: userSettings.ollamaUrl,
        model: userSettings.inferenceModel,
        timezone: userSettings.timezone,
        maxSteps: userSettings.assistantMaxSteps,
      })
      .from(userSettings)
      .where(eq(userSettings.userId, userId))
      .limit(1);
    if (!settings?.url) throw badRequest("No Ollama URL configured for this instance.");
    if (!settings.model)
      throw badRequest("No inference model set. Choose a tool-capable model (e.g. llama3.1, qwen2.5) in Settings.");
    return {
      url: settings.url,
      model: settings.model,
      timezone: settings.timezone,
      maxSteps: settings.maxSteps ?? undefined,
    };
  };

  /** The authoritative "Today is …" line for the system prompt: the current date
   * in the user's configured timezone, so the model never guesses (and relative
   * asks like "tomorrow" line up with how task_find resolves its `when` tokens). */
  const todayLine = (tz: string | null): string => {
    const now = userLocalNow(effectiveTimeZone(tz));
    const pad = (n: number) => String(n).padStart(2, "0");
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
    return `Today is ${weekday}, ${date}${tz ? ` (${tz})` : ""}.`;
  };

  /**
   * What the surface asking this question needs the model to know.
   *
   * Empty for Hermes itself, which is the point: this is not a better prompt,
   * it is a different one for a different caller. Talaria's canvas is a
   * collection the model can already reach with the tools it has — it simply
   * has no way to know which collection somebody means by "this canvas" when
   * the question did not come from a page that is showing one.
   *
   * What is left here is Talaria-specific and nothing else. The rule about
   * reporting only what the tools did started here — it was written after the
   * model answered "here's your updated canvas with all 11 tasks" having called
   * exactly one tool, a search — and moved to the base prompt, because a
   * fluent report of work that did not happen is not a Talaria problem. It is
   * worse than a refusal anywhere, since nobody goes back to check.
   */
  const surfaceLine = (body: { client?: string; canvas?: string }): string => {
    if (body.client !== "talaria") return "";
    const lines = [
      "This question comes from Talaria, whose canvas is a Hermes canvas collection.",
    ];
    if (body.canvas) {
      lines.push(
        `"this canvas", "the canvas" and "my canvas" all mean collection ${body.canvas}. Never create a new canvas for those words — add to, remove from, or restyle that one, with collection_add, collection_remove and canvas_style.`,
        "Replacing it means removing the members it has and adding the new ones. It is not a new collection.",
      );
    }
    lines.push(
      "Talaria draws shapes, borders and regions that Hermes does not. Do not offer sticky notes as a way to get a shape: in Hermes a sticky note and a task block are drawn identically, so it buys nothing and loses the block.",
    );
    return lines.join(" ");
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
  app.post("/assistant/chat", (req, reply) => {
    const userId = requireUser(req);
    // Validate before hijacking, so a bad body is a normal 400.
    const body = z
      .object({
        message: z.string().min(1).max(20_000),
        /**
         * Which surface is asking, and what "this canvas" means there.
         *
         * Only Talaria sends these, and only Talaria should: from Hermes' own
         * canvas view "this canvas" is whichever one the person is looking at,
         * and pointing the model at somebody else's collection because it once
         * heard of it would be worse than the model not knowing.
         */
        // A plain string rather than an enum. An enum turns "a client this
        // build has not heard of" into a 400 on the whole turn, which is a
        // hard failure over a field that is only ever a hint.
        client: z.string().max(64).optional(),
        canvas: z.string().uuid().optional(),
      })
      .parse(req.body);
    const api = apiFor(req);

    // Stream the turn as SSE over the POST response: `token` (reply text as the
    // model writes it), `step` (a tool finished), then a final `done` / `error`.
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    // Stopping is the client dropping the stream. Nothing else can reach a turn
    // that's already streaming — the response is hijacked and the loop is deep
    // in a model call — so the disconnect is the signal, and it aborts the run
    // rather than leaving the model generating into a socket nobody is reading.
    const stop = new AbortController();
    let finished = false;
    res.on("close", () => {
      if (!finished) stop.abort();
    });

    void (async () => {
      try {
        const { url, model, timezone, maxSteps } = await requireModel(userId);
        await appendMessage(userId, "user", body.message);
        const thread = await loadThread(userId);
        const numCtx = await modelContext(url, model);

        const result = await runAgent({
          url,
          model,
          api,
          messages: buildContext(thread),
          confirmDestructive: true,
          numCtx,
          maxSteps,
          signal: stop.signal,
          systemExtra: [todayLine(timezone), surfaceLine(body)].filter(Boolean).join("\n"),
          onEvent: send,
        });

        // Persist the reply (pending destructive calls stay transient — they're
        // resolved via /confirm, which persists their outcome). A stopped turn
        // is persisted too: the tools it ran really ran, and a thread that ends
        // with a question and no answer reads like the app lost the reply.
        const reply = result.stopped
          ? `${result.reply ? `${result.reply}\n\n` : ""}_(stopped)_`
          : result.reply;
        await appendMessage(userId, "assistant", reply, result.steps);
        if (!result.stopped) {
          await maybeSummarize({ userId, url, model, numCtx, promptTokens: result.promptTokens ?? 0 });
        }
        send({ type: "done", reply, steps: result.steps, pending: result.pending, stopped: result.stopped });
      } catch (e) {
        send({
          type: "error",
          message: e instanceof ApiError ? e.body.slice(0, 300) : e instanceof Error ? e.message : "assistant failed",
        });
      } finally {
        finished = true;
        res.end();
      }
    })();
  });

  /** Execute the destructive calls the user just approved in the panel. */
  app.post("/assistant/confirm", async (req) => {
    const userId = requireUser(req);
    // Capped: runConfirmed executes these sequentially as loopback HTTP calls,
    // so an unbounded array turns one request into thousands of self-requests.
    const body = z
      .object({
        calls: z.array(z.object({ tool: z.string(), args: z.unknown() })).min(1).max(25),
      })
      .parse(req.body);
    const result = await runConfirmed({ api: apiFor(req), calls: body.calls });
    await appendMessage(userId, "assistant", "Done.", result.steps);
    return result;
  });
}
