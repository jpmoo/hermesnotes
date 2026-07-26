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
}

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
): Promise<OllamaMessage> {
  const base = url.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, tools, stream: false }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 400);
      throw new Error(`Ollama /api/chat ${res.status}: ${body}`);
    }
    const json = (await res.json()) as { message?: OllamaMessage };
    return json.message ?? { role: "assistant", content: "" };
  } finally {
    clearTimeout(timer);
  }
}

const MAX_STEPS = 8;

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
}): Promise<AgentResult> {
  const registry = defineTools(opts.api);
  const byName = new Map(registry.map((t) => [t.name, t]));
  const tools = toOllamaTools(registry);

  const messages: OllamaMessage[] = [{ role: "system", content: SYSTEM }, ...opts.messages];
  const steps: AgentStep[] = [];

  for (let i = 0; i < MAX_STEPS; i++) {
    const msg = await ollamaChat(opts.url, opts.model, messages, tools);
    messages.push(msg);
    const calls = msg.tool_calls ?? [];
    if (!calls.length) return { reply: msg.content?.trim() || "", steps };

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
      messages.push({ role: "tool", content: step.result });
    }
    if (pending.length) return { reply: msg.content?.trim() || "", steps, pending };
  }
  return { reply: "I stopped after several steps — ask me to continue if needed.", steps };
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
