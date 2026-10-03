import type { PropertySchema } from "@hermes/shared";
import type { Api } from "../mcp/api.js";
import { fmtExtraProps, fmtSchemaFields, refTitleMap } from "../mcp/toolkit.js";
import { loadThread } from "./store.js";
import type { Thread } from "./threads.js";

/**
 * What a discussion on a canvas is about, read fresh from the canvas each turn.
 *
 * A bubble is started from a node — a problem, a decision — and that node's
 * neighbourhood *is* the brief: the learnings and context wired to it, anything
 * wired to the bubble itself, and the other bubbles started from the same node,
 * so a discussion of one option can weigh what was said about another. Nothing
 * is copied into the thread when it starts: the canvas is read again on every
 * message, so connecting a new learning to the problem changes the next answer
 * without anybody re-telling the chat.
 *
 * **One step out, deliberately.** The anchor, what touches it, and what touches
 * the bubble. Two steps would pull in the neighbours' neighbours — on a busy
 * canvas, most of it — and a model handed everything weighs nothing.
 *
 * Read through the loopback API as the person asking, like every tool, so a
 * discussion can never see a block its owner could not. No type is named: a
 * block is described by its own schema's labels, whatever the type is called.
 */

interface Note {
  id: string;
  text?: string;
  shape?: string | null;
  chatId?: string;
}
interface Edge {
  from: string;
  to: string;
  label?: string;
}
interface Region {
  id: string;
  title?: string;
  memberIds?: string[];
}
interface Member {
  id: string;
  blockTypeId: string | null;
  content: string | null;
  properties: Record<string, unknown>;
}

/** Characters for the whole brief, and for any one piece of it. A model's
 * context is shared with the conversation itself; the brief may not crowd it
 * out, and one long note may not crowd out its neighbours. */
const BRIEF_MAX = 14_000;
const PIECE_MAX = 2_500;
/** Of a sibling discussion: its summary, and this many of its latest messages. */
const SIBLING_TURNS = 6;

const clip = (s: string, n = PIECE_MAX) => (s.length > n ? `${s.slice(0, n)}…` : s);

export async function canvasBrief(api: Api, userId: string, thread: Thread): Promise<string> {
  if (!thread.collectionId || !thread.anchorId) return "";
  const { collection, members } = await api.get<{
    collection: { properties: Record<string, unknown> };
    members: Member[];
  }>(`/collections/${thread.collectionId}`);
  const props = collection.properties ?? {};
  const notes = (Array.isArray(props.canvas_notes) ? props.canvas_notes : []) as Note[];
  const edges = (Array.isArray(props.canvas_edges) ? props.canvas_edges : []) as Edge[];
  const regions = (Array.isArray(props.canvas_regions) ? props.canvas_regions : []) as Region[];

  // Undirected: "connected to" is what a person means by a line on a canvas,
  // whichever end they started dragging from.
  const near = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!near.has(a)) near.set(a, new Set());
    near.get(a)!.add(b);
  };
  for (const e of edges) {
    if (!e.from || !e.to) continue;
    link(e.from, e.to);
    link(e.to, e.from);
  }
  const memberById = new Map(members.map((m) => [m.id, m]));
  const noteById = new Map(notes.map((n) => [n.id, n]));
  const regionById = new Map(regions.map((r) => [r.id, r]));

  const anchor = thread.anchorId;
  const bubble = thread.noteId;
  // A region on the end of a line stands for what is in it: wiring a group of
  // learnings to the problem in one stroke is the point of drawing the group.
  const expand = (id: string): string[] => regionById.get(id)?.memberIds ?? [id];
  const around = new Set<string>();
  for (const id of [...(near.get(anchor) ?? []), ...(bubble ? near.get(bubble) ?? [] : [])]) {
    for (const x of expand(id)) around.add(x);
  }
  around.delete(anchor);
  if (bubble) around.delete(bubble);

  const types = await api
    .get<{ id: string; name: string; propertySchema: PropertySchema | null }[]>("/block-types")
    .catch(() => []);
  const typeById = new Map(types.map((t) => [t.id, t]));

  const describeBlock = async (m: Member): Promise<string> => {
    const type = m.blockTypeId ? typeById.get(m.blockTypeId) : undefined;
    const title = typeof m.properties?.title === "string" ? m.properties.title : "";
    const head = `${title || (m.content ?? "").split("\n")[0] || "Untitled"}${type ? ` (${type.name})` : ""}`;
    const lines = [head];
    if (m.content) lines.push(clip(m.content));
    const schema = type?.propertySchema ?? null;
    const refTitles = await refTitleMap(api, schema, m.properties ?? {}).catch(() => new Map<string, string>());
    const fields = [
      ...fmtSchemaFields(schema, m.properties ?? {}, [], refTitles),
      ...fmtExtraProps(schema, m.properties ?? {}),
    ];
    if (fields.length) lines.push(...fields);
    return lines.join("\n");
  };

  const describe = async (id: string): Promise<string | null> => {
    const m = memberById.get(id);
    if (m) return describeBlock(m);
    const n = noteById.get(id);
    if (n && !n.chatId) return n.text?.trim() ? `Note: ${clip(n.text.trim())}` : null;
    return null;
  };

  const sections: string[] = [];
  const anchorText = await describe(anchor);
  sections.push(`## The node this discussion is about\n${anchorText ?? "(an empty node)"}`);

  const context: string[] = [];
  const siblings: Note[] = [];
  for (const id of around) {
    const n = noteById.get(id);
    if (n?.chatId) {
      if (n.chatId !== thread.id) siblings.push(n);
      continue;
    }
    const text = await describe(id);
    if (text) context.push(`### ${text}`);
  }
  if (context.length) sections.push(`## Connected to it\n${context.join("\n\n")}`);

  // Other bubbles off the same node: what was concluded there, so this one
  // need not start from nothing. Their summary and their latest turns — enough
  // to know the gist without replaying a whole other conversation.
  const others: string[] = [];
  for (const s of siblings) {
    const t = await loadThread(userId, s.chatId!).catch(() => null);
    if (!t || (!t.summary && !t.messages.length)) continue;
    const turns = t.messages
      .slice(-SIBLING_TURNS)
      .map((m) => `${m.role === "user" ? "Person" : "Assistant"}: ${clip(m.content, 1_200)}`);
    others.push(
      `### "${(s.text ?? "").trim() || "Untitled discussion"}"\n` +
        (t.summary ? `Summary: ${clip(t.summary, 1_500)}\n` : "") +
        turns.join("\n"),
    );
  }
  if (others.length) sections.push(`## Other discussions started from the same node\n${others.join("\n\n")}`);

  const brief =
    "This conversation lives on a canvas, as a bubble connected to the node it was started from. " +
    "What is connected on the canvas is the context for it — read it before answering, and say which " +
    "pieces you are drawing on. It is re-read on every message, so it may have changed since earlier turns.\n\n" +
    sections.join("\n\n");
  return clip(brief, BRIEF_MAX);
}
