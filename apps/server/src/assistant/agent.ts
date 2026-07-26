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
export interface AgentResult {
  reply: string;
  steps: AgentStep[];
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

/** Run the agent loop until the model stops calling tools (or the step cap). */
export async function runAgent(opts: {
  url: string;
  model: string;
  api: Api;
  messages: { role: "user" | "assistant"; content: string }[];
  onStep?: (step: AgentStep) => void;
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

    for (const call of calls) {
      const name = call.function?.name ?? "";
      let args: unknown = call.function?.arguments ?? {};
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          /* leave as string; validation will report it */
        }
      }
      const def = byName.get(name);
      let result: string;
      let ok = false;
      if (!def) {
        result = `Unknown tool "${name}".`;
      } else {
        try {
          const parsed = z.object(def.schema).parse(args ?? {});
          const r = await def.handler(parsed);
          result = r.content.map((c) => c.text).join("\n");
          ok = !r.isError;
        } catch (e) {
          result = `Error: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      const step: AgentStep = { tool: name, args, result, ok };
      steps.push(step);
      opts.onStep?.(step);
      messages.push({ role: "tool", content: result });
    }
  }
  return { reply: "I stopped after several steps — ask me to continue if needed.", steps };
}
