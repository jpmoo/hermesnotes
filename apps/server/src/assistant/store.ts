import { and, asc, eq, isNull, lte, type SQL } from "drizzle-orm";
import { assistantMessages, type AgentStep } from "@hermes/db";
import { db } from "../db.js";
import { fetchModelContext, summarizeConversation } from "./agent.js";

export interface ThreadMessage {
  role: "user" | "assistant";
  content: string;
  steps?: AgentStep[] | null;
}
interface StoredMessage extends ThreadMessage {
  seq: number;
}

/**
 * Which thread a query is about. `null` is the assistant panel's own thread —
 * every message that predates canvas discussions — and must be asked for as
 * `IS NULL`: `= NULL` matches nothing, and the panel would open empty.
 */
const inThread = (userId: string, threadId: string | null): SQL =>
  and(
    eq(assistantMessages.userId, userId),
    threadId === null ? isNull(assistantMessages.threadId) : eq(assistantMessages.threadId, threadId),
  )!;

/** One thread: the rolling summary (at most one row) plus the verbatim
 * messages after it, in order. */
export async function loadThread(
  userId: string,
  threadId: string | null = null,
): Promise<{ summary: string | null; messages: StoredMessage[] }> {
  const rows = await db
    .select({
      role: assistantMessages.role,
      kind: assistantMessages.kind,
      content: assistantMessages.content,
      steps: assistantMessages.steps,
      seq: assistantMessages.seq,
    })
    .from(assistantMessages)
    .where(inThread(userId, threadId))
    .orderBy(asc(assistantMessages.seq));
  let summary: string | null = null;
  const messages: StoredMessage[] = [];
  for (const r of rows) {
    if (r.kind === "summary") summary = r.content;
    else messages.push({ role: r.role as "user" | "assistant", content: r.content, steps: r.steps, seq: r.seq });
  }
  return { summary, messages };
}

export async function appendMessage(
  userId: string,
  role: "user" | "assistant",
  content: string,
  steps?: AgentStep[] | null,
  threadId: string | null = null,
): Promise<void> {
  await db
    .insert(assistantMessages)
    .values({ userId, threadId, role, kind: "message", content, steps: steps ?? null });
}

/** Empty one thread. The panel's Clear used to mean "every message this user
 * has", which would now also wipe every discussion on every canvas. */
export async function clearThread(userId: string, threadId: string | null = null): Promise<void> {
  await db.delete(assistantMessages).where(inThread(userId, threadId));
}

/** The model context for a turn: the rolling summary (if any) as a lead-in,
 * then the verbatim turns. */
export function buildContext(thread: {
  summary: string | null;
  messages: StoredMessage[];
}): { role: "user" | "assistant"; content: string }[] {
  const turns = thread.messages.map((m) => ({ role: m.role, content: m.content }));
  if (!thread.summary) return turns;
  return [{ role: "assistant", content: `Summary of our earlier conversation:\n${thread.summary}` }, ...turns];
}

// Model context windows rarely change; cache per url+model for the process.
const ctxCache = new Map<string, number>();
export async function modelContext(url: string, model: string): Promise<number> {
  const key = `${url} ${model}`;
  const hit = ctxCache.get(key);
  if (hit) return hit;
  const n = await fetchModelContext(url, model);
  ctxCache.set(key, n);
  return n;
}

const KEEP_RECENT = 6; // verbatim turns always kept out of the summary
const SUMMARIZE_AT = 0.7; // fraction of the context window that triggers a fold
/** Fallback trigger: not every backend reports prompt_eval_count, and without
 * one the token check never fires and the thread would grow without bound. */
const MAX_VERBATIM_MESSAGES = 40;

/**
 * When a turn's prompt nears the model's context window, fold the older turns
 * (plus any prior summary) into the single rolling summary row and drop them,
 * keeping the most recent turns verbatim. Returns whether it summarized.
 */
export async function maybeSummarize(opts: {
  userId: string;
  threadId?: string | null;
  url: string;
  model: string;
  numCtx: number;
  promptTokens: number;
}): Promise<boolean> {
  const threadId = opts.threadId ?? null;
  const thread = await loadThread(opts.userId, threadId);
  if (thread.messages.length <= KEEP_RECENT) return false;
  const overTokens = opts.promptTokens > 0 && opts.promptTokens >= opts.numCtx * SUMMARIZE_AT;
  if (!overTokens && thread.messages.length < MAX_VERBATIM_MESSAGES) return false;

  const older = thread.messages.slice(0, thread.messages.length - KEEP_RECENT);
  const cutoffSeq = older[older.length - 1]!.seq;
  const input = [
    ...(thread.summary ? [{ role: "system", content: thread.summary }] : []),
    ...older.map((m) => ({ role: m.role, content: m.content })),
  ];
  const summaryText = await summarizeConversation(opts.url, opts.model, input, opts.numCtx);
  if (!summaryText) return false;

  await db.transaction(async (tx) => {
    await tx
      .delete(assistantMessages)
      .where(
        and(
          inThread(opts.userId, threadId),
          eq(assistantMessages.kind, "message"),
          lte(assistantMessages.seq, cutoffSeq),
        ),
      );
    await tx
      .delete(assistantMessages)
      .where(and(inThread(opts.userId, threadId), eq(assistantMessages.kind, "summary")));
    await tx
      .insert(assistantMessages)
      .values({ userId: opts.userId, threadId, role: "assistant", kind: "summary", content: summaryText });
  });
  return true;
}
