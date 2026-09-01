import { z } from "zod";
import {
  findItem,
  findRegion,
  freeSpot,
  newId,
  readCanvas,
  SHAPES,
  writeCanvas,
  type CanvasDocument,
} from "./canvas.js";
import type { Interchange } from "./interchange.js";

/**
 * Talaria's own chat: a canvas, and nothing else.
 *
 * **The scope is the design.** This chat draws. It can make nodes, colour them,
 * shape them, connect them, group them and take them off again, and that is the
 * entire list. It cannot create a task, complete one, rename a block or change
 * anything in Hermes — the other chat in this app does that, through Hermes'
 * own assistant, and having two ways to change one library is two places to
 * look when something changed that nobody meant to change.
 *
 * It *reads* Hermes through the interchange binding, because a canvas about
 * your work needs to know what your work is. Search and read only: it can find
 * the tasks in a project and put them on the canvas, and putting them there
 * changes nothing about them.
 *
 * Which makes the boundary easy to state and easy to check: everything this
 * chat does is visible on the canvas in front of you, and nothing it does
 * survives deleting the canvas.
 */
const SYSTEM = `You are the canvas assistant inside Talaria, a local canvas app.

WHAT YOU DO: you build and change the canvas the user is looking at. Nodes, their words, their shape and colour, the lines between them, and the regions grouping them. That is all you do.

WHAT YOU DO NOT DO: you cannot create, complete, rename, tag or change anything in Hermes Notes. You have no tools for it and you must not claim otherwise. If the user asks for that, say plainly that the Hermes chat does it and this one only draws. You CAN look things up in Hermes with hermes_search, and put what you find on the canvas — looking a thing up changes nothing about it.

Guidance:
- Prefer acting over asking. If a request is doable with the tools, do it, then say what you drew.
- Anything that came from Hermes goes on with canvas_add_blocks, never canvas_add. A node made with canvas_add is inert text; one made with canvas_add_blocks is the task itself — it shows the block's own title, its icon, and a checkbox that completes it. Putting a task on as plain words throws all of that away, and looks identical until somebody tries to tick it.
- Tools that take a list take the whole list. Adding twelve nodes is one call to canvas_add, not twelve.
- Refer to nodes by their words when you can; ids are only needed when two nodes say the same thing.
- Shapes are: plain (no outline), rectangle, roundedRectangle, ellipse, triangle. There is no other shape. If somebody asks for one you do not have, say which you do have rather than substituting one silently.
- Colours are CSS hex like #f97316.
- Report only what your tools actually did. If you did not call a tool, you did not do the thing.
- Be concise.`;

interface ToolCall {
  function?: { name?: string; arguments?: unknown };
}
interface Message {
  role: string;
  content?: string;
  tool_calls?: ToolCall[];
}

export interface Step {
  tool: string;
  result: string;
  ok: boolean;
}
export interface Turn {
  reply: string;
  steps: Step[];
  stopped?: boolean;
}

interface Tool {
  name: string;
  description: string;
  /** Checked before the handler sees anything. */
  schema: z.ZodObject<z.ZodRawShape>;
  /**
   * The same shape, as the model is told it.
   *
   * Written out rather than derived. Deriving it means a dependency whose whole
   * job is translating one small object into another, for seven tools whose
   * arguments are strings, numbers and lists of strings — and the derived
   * version still has to be read to know what the model was actually sent.
   */
  parameters: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<string> | string;
}

const str = { type: "string" };
const strs = { type: "array", items: { type: "string" } };
const num = { type: "number" };
const params = (props: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: props,
  ...(required.length ? { required } : {}),
});

const HEX = z.string().regex(/^#[0-9a-fA-F]{3,8}$/, "a colour like #f97316");

/**
 * The tools, built fresh per turn around the document as it stands.
 *
 * Read at the start and written after each change rather than held: the app is
 * writing the same file whenever somebody drags something, and a document held
 * across a whole conversation would put back whatever they moved in the middle
 * of it.
 */
export function tools(ix: Interchange): Tool[] {
  const load = () => readCanvas();
  const save = (d: CanvasDocument) => writeCanvas(d);

  return [
    {
      name: "canvas_read",
      description:
        "What is on the canvas now: every node with its words, shape and colour, every connection, every region. Call this first if you need to change something that is already there.",
      parameters: params({}),
      schema: z.object({}),
      run: () => {
        const d = load();
        if (!d.items.length && !d.regions.length) return "The canvas is empty.";
        const nodes = d.items.map(
          (i) =>
            `- ${i.text?.trim() || "(no words)"} [${i.id}]${i.shape && i.shape !== "plain" ? ` ${i.shape}` : ""}${i.fill ? ` ${i.fill}` : ""}${i.blockId ? " (linked to a Hermes block)" : ""}`,
        );
        const lines = d.links.map((l) => `- ${l.from} → ${l.to}`);
        const groups = d.regions.map((r) => `- ${r.title || "(untitled)"} holding ${r.members.length}`);
        return [
          `${d.items.length} node(s):`,
          ...nodes,
          lines.length ? `${lines.length} connection(s):` : "",
          ...lines,
          groups.length ? `${groups.length} region(s):` : "",
          ...groups,
        ]
          .filter(Boolean)
          .join("\n");
      },
    },
    {
      name: "canvas_add",
      description:
        "Put new nodes on the canvas. Pass every node in one call. Each is words, and optionally a shape and a colour. They are laid out clear of what is already there.",
      parameters: params({ texts: strs, shape: { type: "string", enum: SHAPES }, fill: str, w: num, h: num }, ["texts"]),
      schema: z.object({
        texts: z.array(z.string()).min(1),
        shape: z.enum(SHAPES).default("roundedRectangle"),
        fill: HEX.optional(),
        w: z.number().min(20).max(2000).default(160),
        h: z.number().min(20).max(2000).default(90),
      }),
      run: (a) => {
        const args = a as { texts: string[]; shape: string; fill?: string; w: number; h: number };
        const d = load();
        const made: string[] = [];
        for (const text of args.texts) {
          const at = freeSpot(d, args.w, args.h);
          const id = newId();
          d.items.push({
            id,
            x: at.x,
            y: at.y,
            w: args.w,
            h: args.h,
            text,
            shape: args.shape,
            fill: args.fill ?? null,
            strokeWidth: 1.5,
            strokeStyle: "solid",
            hAlign: "center",
            vAlign: "middle",
          });
          made.push(text);
        }
        save(d);
        return `Added ${made.length} node(s): ${made.join(", ")}.`;
      },
    },
    {
      name: "canvas_add_blocks",
      description:
        "Put Hermes Notes blocks on the canvas as LIVE nodes. Use this — not canvas_add — for anything that came back from hermes_search. " +
        "A live node wears the block's own title, its type's icon, and a checkbox you can tick if it is a task; it keeps up with the block as that changes. " +
        "Pass the block ids from hermes_search, all of them in one call.",
      parameters: params({ blocks: strs, shape: { type: "string", enum: SHAPES }, fill: str, w: num, h: num }, ["blocks"]),
      schema: z.object({
        blocks: z.array(z.string().uuid()).min(1),
        shape: z.enum(SHAPES).default("roundedRectangle"),
        fill: HEX.optional(),
        w: z.number().min(20).max(2000).default(180),
        h: z.number().min(20).max(2000).default(100),
      }),
      run: (a) => {
        const args = a as { blocks: string[]; shape: string; fill?: string; w: number; h: number };
        const d = load();
        /**
         * No words of its own.
         *
         * A live node wears its block's title and stores no copy — a copy
         * drifts the moment somebody renames the block, and the whole reason to
         * bring a task in as a task rather than as a note is that it keeps up.
         * Writing the title here would quietly turn it back into a note that
         * happens to have started life as a task.
         */
        let added = 0;
        for (const blockId of args.blocks) {
          if (d.items.some((i) => i.blockId === blockId)) continue; // already here
          const at = freeSpot(d, args.w, args.h);
          d.items.push({
            id: newId(),
            x: at.x,
            y: at.y,
            w: args.w,
            h: args.h,
            text: "",
            shape: args.shape,
            fill: args.fill ?? null,
            strokeWidth: 1.5,
            strokeStyle: "solid",
            hAlign: "center",
            vAlign: "middle",
            blockId,
          });
          added += 1;
        }
        save(d);
        const already = args.blocks.length - added;
        return `Put ${added} live block(s) on the canvas.${already ? ` ${already} were already there.` : ""} They show their own titles and stay in step with Hermes.`;
      },
    },
    {
      name: "canvas_restyle",
      description:
        "Change how existing nodes look: shape, fill colour, text colour, border. Name them by their words or ids. Pass every node you are changing in one call.",
      parameters: params({ nodes: strs, shape: { type: "string", enum: SHAPES }, fill: str, textColor: str, stroke: str, strokeWidth: num }, ["nodes"]),
      schema: z.object({
        nodes: z.array(z.string()).min(1),
        shape: z.enum(SHAPES).optional(),
        fill: HEX.optional(),
        textColor: HEX.optional(),
        stroke: HEX.optional(),
        strokeWidth: z.number().min(0).max(20).optional(),
      }),
      run: (a) => {
        const args = a as Record<string, unknown> & { nodes: string[] };
        const d = load();
        let hit = 0;
        const missed: string[] = [];
        for (const name of args.nodes) {
          const item = findItem(d, name);
          if (!item) {
            missed.push(name);
            continue;
          }
          if (typeof args.shape === "string") item.shape = args.shape;
          if (typeof args.fill === "string") item.fill = args.fill;
          if (typeof args.textColor === "string") item.textColor = args.textColor;
          if (typeof args.stroke === "string") item.stroke = args.stroke;
          if (typeof args.strokeWidth === "number") item.strokeWidth = args.strokeWidth;
          hit += 1;
        }
        save(d);
        // Named rather than counted. "Restyled 3 of 5" leaves the model to
        // guess which two, and it guesses.
        return `Restyled ${hit} node(s).${missed.length ? ` Not found: ${missed.join(", ")}.` : ""}`;
      },
    },
    {
      name: "canvas_connect",
      description: "Draw an arrow from one node to another. Name them by their words or ids.",
      parameters: params({ from: str, to: str, color: str }, ["from", "to"]),
      schema: z.object({ from: z.string(), to: z.string(), color: HEX.optional() }),
      run: (a) => {
        const args = a as { from: string; to: string; color?: string };
        const d = load();
        const from = findItem(d, args.from);
        const to = findItem(d, args.to);
        if (!from) return `No node matching "${args.from}".`;
        if (!to) return `No node matching "${args.to}".`;
        if (from.id === to.id) return "A node cannot be connected to itself.";
        d.links.push({
          id: newId(),
          from: from.id,
          to: to.id,
          bendX: 0,
          bendY: 0,
          width: 1.5,
          style: "solid",
          ...(args.color ? { color: args.color } : {}),
        });
        save(d);
        return `Connected ${from.text?.trim() || from.id} → ${to.text?.trim() || to.id}.`;
      },
    },
    {
      name: "canvas_group",
      description: "Draw a region around some nodes, with a title. Name the nodes by their words or ids.",
      parameters: params({ nodes: strs, title: str, fill: str }, ["nodes"]),
      schema: z.object({ nodes: z.array(z.string()).min(1), title: z.string().default(""), fill: HEX.optional() }),
      run: (a) => {
        const args = a as { nodes: string[]; title: string; fill?: string };
        const d = load();
        const members = args.nodes.map((n) => findItem(d, n)).filter((i): i is NonNullable<typeof i> => !!i);
        if (!members.length) return "None of those nodes are on the canvas.";
        d.regions.push({
          id: newId(),
          members: members.map((m) => m.id),
          title: args.title,
          hAlign: "leading",
          strokeWidth: 1.5,
          strokeStyle: "dashed",
          ...(args.fill ? { fill: args.fill } : {}),
        });
        save(d);
        return `Grouped ${members.length} node(s)${args.title ? ` as "${args.title}"` : ""}.`;
      },
    },
    {
      name: "canvas_remove",
      description:
        "Take nodes off the canvas. This removes them from the canvas only — a node linked to a Hermes block leaves the block alone.",
      parameters: params({ nodes: strs }, ["nodes"]),
      schema: z.object({ nodes: z.array(z.string()).min(1) }),
      run: (a) => {
        const args = a as { nodes: string[] };
        const d = load();
        const gone = new Set<string>();
        for (const name of args.nodes) {
          const item = findItem(d, name);
          if (item) gone.add(item.id);
        }
        if (!gone.size) return "None of those are on the canvas.";
        d.items = d.items.filter((i) => !gone.has(i.id));
        d.links = d.links.filter((l) => !gone.has(l.from) && !gone.has(l.to));
        d.regions = d.regions
          .map((r) => ({ ...r, members: r.members.filter((m) => !gone.has(m)) }))
          .filter((r) => r.members.length);
        save(d);
        return `Removed ${gone.size} node(s). Any Hermes blocks they stood for are untouched.`;
      },
    },
    {
      name: "hermes_search",
      description:
        "Look something up in Hermes Notes — tasks, notes, people, anything — so you can put it on the canvas. Read only: this changes nothing in Hermes. " +
        "Answers matching blocks with their titles and ids; put them on the canvas with canvas_add_blocks so they stay live.",
      parameters: params({ text: str, limit: num }, ["text"]),
      schema: z.object({ text: z.string().min(1), limit: z.number().min(1).max(50).default(20) }),
      run: async (a) => {
        const args = a as { text: string; limit: number };
        const env = (await ix.search(args.text)) as { objects?: Record<string, unknown>[] };
        const hits = (env.objects ?? []).slice(0, args.limit);
        if (!hits.length) return `Nothing in Hermes matches "${args.text}".`;
        return hits
          .map((o) => {
            const props = (o.properties ?? {}) as Record<string, unknown>;
            const title = typeof props.title === "string" ? props.title : "(untitled)";
            return `- ${title} [${String(o.id)}]`;
          })
          .join("\n");
      },
    },
  ];
}

function forOllama(list: Tool[]) {
  return list.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/**
 * One turn.
 *
 * Its own loop rather than Hermes'. The tools are entirely different, it runs
 * against a different model on a different machine, and the one thing the two
 * share — "call tools until the model stops" — is twenty lines. Importing
 * Hermes' would mean the canvas depending on the shape of the PKM's agent,
 * which is the coupling this whole app is trying not to have.
 */
export async function runCanvasChat(opts: {
  url: string;
  model: string;
  ix: Interchange;
  messages: { role: "user" | "assistant"; content: string }[];
  maxSteps?: number;
}): Promise<Turn> {
  const registry = tools(opts.ix);
  const byName = new Map(registry.map((t) => [t.name, t]));
  const declared = forOllama(registry);

  const messages: Message[] = [{ role: "system", content: SYSTEM }, ...opts.messages];
  const steps: Step[] = [];
  const maxSteps = Math.min(20, Math.max(1, opts.maxSteps ?? 12));
  let lastText = "";

  for (let i = 0; i < maxSteps; i++) {
    const res = await fetch(`${opts.url.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: opts.model, messages, tools: declared, stream: false }),
    });
    if (!res.ok) throw new Error(`the model at ${opts.url} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { message?: Message };
    const msg = json.message ?? { role: "assistant", content: "" };
    messages.push(msg);
    if (msg.content?.trim()) lastText = msg.content.trim();

    const calls = msg.tool_calls ?? [];
    if (!calls.length) return { reply: msg.content?.trim() || lastText, steps };

    for (const call of calls) {
      const name = call.function?.name ?? "";
      const tool = byName.get(name);
      let result: string;
      let ok = true;
      if (!tool) {
        // Named rather than ignored. A model that calls a tool which is not
        // there needs to be told, or it calls it again.
        result = `There is no tool called ${name}. This assistant only draws on the canvas.`;
        ok = false;
      } else {
        try {
          const raw = call.function?.arguments;
          const parsed = tool.schema.parse(typeof raw === "string" ? JSON.parse(raw || "{}") : (raw ?? {}));
          result = await tool.run(parsed as Record<string, unknown>);
        } catch (err) {
          result = `That did not work: ${(err as Error).message}`;
          ok = false;
        }
      }
      steps.push({ tool: name, result, ok });
      messages.push({ role: "tool", content: result });
    }
  }
  return { reply: lastText, steps, stopped: true };
}
