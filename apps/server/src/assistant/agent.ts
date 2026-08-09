import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Api } from "../mcp/api.js";
import { defineTools, type ToolDef } from "../mcp/toolkit.js";

/**
 * In-app AI assistant: a server-side agent loop over the SAME shared tool
 * registry that external agents reach through MCP. It's driven by the user's
 * configured Ollama inference model via /api/chat's tool-calling. The model
 * makes the semantic decisions; the tools do the mechanical work.
 */

const SYSTEM = `You are the assistant inside Hermes Notes, a block-first personal knowledge base.
You help the user by USING TOOLS to search, read, create, edit, organise, and delete their blocks and collections.

Guidance:
- Prefer acting over asking. If a request is doable with the tools, do it, then report what you did with the ids.
- To reference something the user names, first find it (search / task_find / list_types / list_lists) to get its id.
- Blocks come in types (task, event, person, project, plain notes, …); collections come in kinds (list, document, matrix, table, canvas, kanban, masonry, calendar).
- For "arrange these on a canvas" style requests: decide a sensible order/grouping yourself, then call canvas_create with the items in that order (use connect=true for an ordered flow).
- Dates: trust the "Today is …" line below as the current date — never guess it. For due-date questions use task_find's \`when\` filter (today, tomorrow, week, overdue, available, unscheduled) rather than computing dates yourself; today/tomorrow/week already include still-open overdue tasks (each line tags them OVERDUE).
- When you report a task list, make the count match what you list: if a due-date query pulled in OVERDUE items too, give the total and break it down (e.g. "7 tasks — 6 due tomorrow, 1 overdue"), don't state a smaller number than you show.
- Be concise. Don't invent ids — only use ids returned by tools.`;

interface OllamaToolCall {
  function?: { name?: string; arguments?: unknown };
}
interface OllamaMessage {
  role: string;
  content?: string;
  tool_calls?: OllamaToolCall[];
}

export interface AgentStep {
  tool: string;
  args: unknown;
  result: string;
  ok: boolean;
}
export interface PendingCall {
  tool: string;
  args?: unknown;
}
export interface AgentResult {
  reply: string;
  steps: AgentStep[];
  /** Destructive calls the agent wants to make, awaiting the user's confirmation. */
  pending?: PendingCall[];
  /** Actual prompt tokens the model reported for the final turn (for context mgmt). */
  promptTokens?: number;
}

/** Progress emitted during a streamed turn: reply tokens as the model writes
 * them, and a step each time a tool finishes. */
export type AgentEvent = { type: "token"; text: string } | { type: "step"; step: AgentStep };

/** Convert the shared tool registry into Ollama's function-tool format. */
function toOllamaTools(tools: ToolDef[]) {
  return tools.map((t) => {
    const schema = zodToJsonSchema(z.object(t.schema), { $refStrategy: "none" }) as Record<string, unknown>;
    delete schema.$schema;
    return {
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: schema },
    };
  });
}

async function ollamaChat(
  url: string,
  model: string,
  messages: OllamaMessage[],
  tools: ReturnType<typeof toOllamaTools>,
  numCtx?: number,
  onToken?: (t: string) => void,
): Promise<{ message: OllamaMessage; promptTokens: number }> {
  const base = url.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  const stream = Boolean(onToken);
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        tools,
        stream,
        ...(numCtx ? { options: { num_ctx: numCtx } } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 400);
      throw new Error(`Ollama /api/chat ${res.status}: ${body}`);
    }
    if (!stream) {
      const json = (await res.json()) as { message?: OllamaMessage; prompt_eval_count?: number };
      return { message: json.message ?? { role: "assistant", content: "" }, promptTokens: json.prompt_eval_count ?? 0 };
    }
    // Streaming: Ollama emits one JSON object per line; accumulate content (and
    // tool_calls, which arrive whole in a chunk) while forwarding text tokens.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let content = "";
    let role = "assistant";
    let toolCalls: OllamaToolCall[] | undefined;
    let promptTokens = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let obj: { message?: OllamaMessage; prompt_eval_count?: number };
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        const m = obj.message;
        if (m?.role) role = m.role;
        if (m?.content) {
          content += m.content;
          onToken!(m.content);
        }
        if (m?.tool_calls?.length) toolCalls = m.tool_calls;
        if (typeof obj.prompt_eval_count === "number") promptTokens = obj.prompt_eval_count;
      }
    }
    return {
      message: { role, content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
      promptTokens,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The model's maximum context window (tokens), read from Ollama's /api/show
 * `model_info` (the `*.context_length` field). Falls back to 8192 when the
 * field is absent or the call fails, so context management always has a number.
 */
export async function fetchModelContext(url: string, model: string): Promise<number> {
  const base = url.replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
    if (!res.ok) return 8192;
    const json = (await res.json()) as { model_info?: Record<string, unknown> };
    const info = json.model_info ?? {};
    const key = Object.keys(info).find((k) => k.endsWith(".context_length"));
    const val = key ? Number(info[key]) : NaN;
    return Number.isFinite(val) && val > 0 ? val : 8192;
  } catch {
    return 8192;
  }
}

/** Condense a run of older turns into a compact third-person summary that
 * preserves ids, decisions, and open threads, for use as rolling context. */
export async function summarizeConversation(
  url: string,
  model: string,
  turns: { role: string; content: string }[],
  numCtx?: number,
): Promise<string> {
  const transcript = turns.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");
  const { message } = await ollamaChat(
    url,
    model,
    [
      {
        role: "system",
        content:
          "Summarize the following assistant/user conversation into a concise briefing that preserves any " +
          "block/collection ids, decisions made, tasks/canvases created, and unresolved threads. Write it so a " +
          "fresh assistant could continue seamlessly. Prose or bullets, no preamble.",
      },
      { role: "user", content: transcript },
    ],
    [],
    numCtx,
  );
  return message.content?.trim() || "";
}

/**
 * Turns allowed on one message. A turn is one exchange with the model, not one
 * tool: a model that batches three calls into a message spends one, and a model
 * that calls them one at a time spends three — which is what local models
 * mostly do, so this has to be generous to be useful. It exists at all so a
 * confused model can't loop forever, each iteration carrying the whole history.
 */
const DEFAULT_MAX_STEPS = 20;

const normArgs = (raw: unknown): unknown => {
  if (typeof raw !== "string") return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

/** Execute one tool by name against the registry, returning a step. */
async function execTool(byName: Map<string, ToolDef>, name: string, args: unknown): Promise<AgentStep> {
  const def = byName.get(name);
  if (!def) return { tool: name, args, result: `Unknown tool "${name}".`, ok: false };
  try {
    const parsed = z.object(def.schema).parse(args ?? {});
    const r = await def.handler(parsed);
    return { tool: name, args, result: r.content.map((c) => c.text).join("\n"), ok: !r.isError };
  } catch (e) {
    return { tool: name, args, result: `Error: ${e instanceof Error ? e.message : String(e)}`, ok: false };
  }
}

/** Run the agent loop until the model stops calling tools (or the step cap).
 *  When `confirmDestructive`, destructive tool calls are not executed — they're
 *  returned as `pending` for the user to approve, and the loop stops there. */
export async function runAgent(opts: {
  url: string;
  model: string;
  api: Api;
  messages: { role: "user" | "assistant"; content: string }[];
  confirmDestructive?: boolean;
  numCtx?: number;
  /** Turns allowed for this message; see DEFAULT_MAX_STEPS. */
  maxSteps?: number;
  /** A line appended to the system prompt (e.g. the authoritative current date
   * in the user's timezone) so the model never has to guess it. */
  systemExtra?: string;
  /** When set, the turn streams: reply tokens and finished tool steps are pushed
   * here as they happen (in addition to the final AgentResult). */
  onEvent?: (ev: AgentEvent) => void;
}): Promise<AgentResult> {
  const registry = defineTools(opts.api);
  const byName = new Map(registry.map((t) => [t.name, t]));
  const tools = toOllamaTools(registry);

  const system = opts.systemExtra ? `${SYSTEM}\n\n${opts.systemExtra}` : SYSTEM;
  const messages: OllamaMessage[] = [{ role: "system", content: system }, ...opts.messages];
  const steps: AgentStep[] = [];
  let promptTokens = 0;
  const onToken = opts.onEvent ? (t: string) => opts.onEvent!({ type: "token", text: t }) : undefined;

  const maxSteps = Math.min(50, Math.max(1, opts.maxSteps ?? DEFAULT_MAX_STEPS));
  let lastText = "";
  for (let i = 0; i < maxSteps; i++) {
    const { message: msg, promptTokens: pt } = await ollamaChat(opts.url, opts.model, messages, tools, opts.numCtx, onToken);
    promptTokens = pt || promptTokens;
    messages.push(msg);
    if (msg.content?.trim()) lastText = msg.content.trim();
    const calls = msg.tool_calls ?? [];
    if (!calls.length) return { reply: msg.content?.trim() || "", steps, promptTokens };

    const pending: PendingCall[] = [];
    for (const call of calls) {
      const name = call.function?.name ?? "";
      const args = normArgs(call.function?.arguments);
      if (opts.confirmDestructive && byName.get(name)?.destructive) {
        pending.push({ tool: name, args });
        continue; // hold for user approval
      }
      const step = await execTool(byName, name, args);
      steps.push(step);
      opts.onEvent?.({ type: "step", step });
      messages.push({ role: "tool", content: step.result });
    }
    if (pending.length) return { reply: msg.content?.trim() || "", steps, pending, promptTokens };
  }
  // Out of turns, mid-task. Saying so is not enough on its own: "continue" is a
  // guess unless it's clear what was already done and what was left.
  const used = [...new Set(steps.map((s) => s.tool))];
  const reply = [
    `I used all ${maxSteps} steps allowed for one message before finishing.`,
    used.length ? ` So far: ${used.join(", ")}.` : "",
    lastText ? `\n\n${lastText}` : "",
    `\n\nTell me to continue and I'll pick up from here — or raise the limit in Settings → AI if this keeps happening.`,
  ].join("");
  return { reply, steps, promptTokens };
}

/** Execute a set of user-confirmed calls (destructive tools only). */
export async function runConfirmed(opts: { api: Api; calls: PendingCall[] }): Promise<{ steps: AgentStep[] }> {
  const byName = new Map(defineTools(opts.api).map((t) => [t.name, t]));
  const steps: AgentStep[] = [];
  for (const c of opts.calls) {
    if (!byName.get(c.tool)?.destructive) {
      steps.push({ tool: c.tool, args: c.args, result: "Refused: only destructive tools run through confirm.", ok: false });
      continue;
    }
    steps.push(await execTool(byName, c.tool, c.args));
  }
  return { steps };
}
