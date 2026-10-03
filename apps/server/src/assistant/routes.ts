import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { userLocalNow } from "@hermes/shared";
import { userSettings } from "@hermes/db";
import { db } from "../db.js";
import { env } from "../env.js";
import { badRequest, notFound } from "../lib/errors.js";
import { authenticate, requireUser } from "../auth/middleware.js";
import { Api, ApiError, type ApiAuth } from "../mcp/api.js";
import { runAgent, runConfirmed } from "./agent.js";
import { appendMessage, buildContext, clearThread, loadThread, maybeSummarize, modelContext } from "./store.js";
import { createThread, deleteThread, getThread, renameThread, threadsOn, type Thread } from "./threads.js";
import { canvasBrief } from "./context.js";
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
   * Empty for Hermes itself, which is the point: not a better prompt, a
   * different one for a different caller.
   *
   * It used to also name the collection Talaria's canvas was backed by. That
   * backing is gone — Talaria's canvas is its own document now and nothing here
   * knows it — so what is left is the one thing still true: Talaria draws
   * things Hermes does not, and the model should not offer a Hermes shape as a
   * substitute for one.
   */
  const surfaceLine = (body: { client?: string }): string =>
    body.client === "talaria"
      ? "This question comes from Talaria, which has a canvas of its own that Hermes cannot see or draw. Do not offer to put anything on a Hermes canvas as a way of satisfying a request about theirs, and do not offer sticky notes as a way to get a shape: in Hermes a sticky note and a task block are drawn identically."
      : "";

  /**
   * Which thread a request is about: none (the panel's own), or one of this
   * user's canvas discussions. An id that names somebody else's thread, or none
   * at all, is a 404 — never a silent fall-back to the panel's thread, which
   * would put a canvas question into the wrong conversation.
   */
  const threadFor = async (userId: string, threadId: string | undefined): Promise<Thread | null> => {
    if (!threadId) return null;
    const t = await getThread(userId, threadId);
    if (!t) throw notFound("No such discussion.");
    return t;
  };
  const threadQuery = z.object({ threadId: z.string().uuid().optional() });

  /** The persisted conversation (for hydrating the panel on load). */
  app.get("/assistant/messages", async (req) => {
    const userId = requireUser(req);
    const t = await threadFor(userId, threadQuery.parse(req.query).threadId);
    const thread = await loadThread(userId, t?.id ?? null);
    return {
      messages: thread.messages.map((m) => ({ role: m.role, content: m.content, steps: m.steps ?? undefined })),
      summarized: thread.summary !== null,
    };
  });

  /** Wipe the conversation — zeroes the context the next turn is built from. */
  app.delete("/assistant/messages", async (req) => {
    const userId = requireUser(req);
    const t = await threadFor(userId, threadQuery.parse(req.query).threadId);
    await clearThread(userId, t?.id ?? null);
    return { ok: true };
  });

  // ── Discussions on a canvas ────────────────────────────────────────────
  //
  // A bubble on a canvas is an ordinary canvas note whose `chatId` names one of
  // these. The canvas draws and places it; this only keeps the conversation and
  // remembers where it sits, so its context can be read from what surrounds it.

  app.post("/assistant/threads", async (req) => {
    const userId = requireUser(req);
    const body = z
      .object({
        id: z.string().uuid().optional(),
        collectionId: z.string().uuid(),
        // A block id or an `n:` note id — the vocabulary of canvas_edges.
        anchorId: z.string().min(1).max(200),
        noteId: z.string().min(1).max(200),
        title: z.string().max(200).optional(),
      })
      .parse(req.body);
    return createThread(userId, body);
  });

  app.get("/assistant/threads", async (req) => {
    const userId = requireUser(req);
    const q = z.object({ collectionId: z.string().uuid() }).parse(req.query);
    return { threads: await threadsOn(userId, q.collectionId) };
  });

  app.get("/assistant/threads/:id", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const t = await threadFor(userId, id);
    return t!;
  });

  app.patch("/assistant/threads/:id", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { title } = z.object({ title: z.string().max(200) }).parse(req.body);
    await threadFor(userId, id);
    await renameThread(userId, id, title);
    return { ok: true };
  });

  /** The bubble was removed from the canvas: its conversation goes with it. */
  app.delete("/assistant/threads/:id", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await threadFor(userId, id);
    await deleteThread(userId, id);
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
        /** A canvas discussion, or absent for the panel's own thread. */
        threadId: z.string().uuid().optional(),
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
        const t = await threadFor(userId, body.threadId);
        const threadId = t?.id ?? null;
        await appendMessage(userId, "user", body.message, null, threadId);
        const thread = await loadThread(userId, threadId);
        const numCtx = await modelContext(url, model);
        // A discussion is named by the question that opened it — what the
        // bubble shows on the canvas — unless somebody has named it already.
        let title: string | undefined;
        if (t && !t.title.trim()) {
          title = body.message.replace(/\s+/g, " ").trim().slice(0, 80);
          await renameThread(userId, t.id, title);
        }
        // Read the canvas fresh for this turn. A canvas that cannot be read is
        // a thinner answer, not a failed one.
        const brief = t ? await canvasBrief(api, userId, t).catch(() => "") : "";

        const result = await runAgent({
          url,
          model,
          api,
          messages: buildContext(thread),
          confirmDestructive: true,
          numCtx,
          maxSteps,
          signal: stop.signal,
          systemExtra: [todayLine(timezone), surfaceLine(body), brief].filter(Boolean).join("\n"),
          onEvent: send,
        });

        // Persist the reply (pending destructive calls stay transient — they're
        // resolved via /confirm, which persists their outcome). A stopped turn
        // is persisted too: the tools it ran really ran, and a thread that ends
        // with a question and no answer reads like the app lost the reply.
        const reply = result.stopped
          ? `${result.reply ? `${result.reply}\n\n` : ""}_(stopped)_`
          : result.reply;
        await appendMessage(userId, "assistant", reply, result.steps, threadId);
        if (!result.stopped) {
          await maybeSummarize({ userId, threadId, url, model, numCtx, promptTokens: result.promptTokens ?? 0 });
        }
        send({
          type: "done",
          reply,
          steps: result.steps,
          pending: result.pending,
          stopped: result.stopped,
          ...(title ? { title } : {}),
        });
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
        threadId: z.string().uuid().optional(),
      })
      .parse(req.body);
    const t = await threadFor(userId, body.threadId);
    const result = await runConfirmed({ api: apiFor(req), calls: body.calls });
    await appendMessage(userId, "assistant", "Done.", result.steps, t?.id ?? null);
    return result;
  });
}
