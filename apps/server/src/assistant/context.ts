import type { PropertySchema } from "@hermes/shared";
import type { Api } from "../mcp/api.js";
import { fmtExtraProps, fmtSchemaFields, refTitleMap } from "../mcp/toolkit.js";
import { loadThread } from "./store.js";
import type { Thread } from "./threads.js";

/**
 * What a discussion on a canvas is about: the whole canvas, read fresh each
 * turn, as an outline under its questions.
 *
 * A canvas for thinking something through has a shape — problems and
 * questions, and under each the learnings, context and considerations wired to
 * it, which may themselves have things wired to them. Some considerations bear
 * on more than one problem, and that is often the most useful thing on the
 * map. So the brief is the map's own outline rather than a flat list:
 *
 *   - **The discussion's own node first, in detail**, with everything wired
 *     straight to it — and to the cloud — at full length. That is what the
 *     person is asking about.
 *   - **Then every question on the canvas** (nodes marked as a problem or
 *     question — a canvas-only mark, `question` on the placement or the note),
 *     with what can be reached from it laid out beneath. A branch stops where
 *     it meets another question and says so, rather than wandering into that
 *     question's territory.
 *   - **Anything reached from more than one question says so** — "(also bears
 *     on: …)" — so the model can see the shared considerations.
 *   - **What no question reaches** is listed last, under "Elsewhere".
 *   - **Discussions:** the other clouds off this node in full (summary and
 *     latest turns), the ones under other questions as a line each.
 *
 * Detail falls away with distance, so the whole map fits: full text near the
 * discussion, a first line further out, a title at the edges, and a hard cap
 * on the lot. Read through the loopback API as the person asking, like every
 * tool; no type is named — a block is described by its own schema's labels.
 */

interface Note {
  id: string;
  text?: string;
  chatId?: string;
  question?: boolean;
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
  context?: Record<string, unknown> | null;
}

/** Characters for the whole brief, and for any one detailed piece of it. */
const BRIEF_MAX = 18_000;
const PIECE_MAX = 2_000;
/** How far below a question the outline goes before it stops expanding. */
const OUTLINE_DEPTH = 4;
/** Of a sibling discussion: its summary, and this many of its latest messages. */
const SIBLING_TURNS = 6;

const clip = (s: string, n = PIECE_MAX) => (s.length > n ? `${s.slice(0, n)}…` : s);
const oneLine = (s: string, n = 160) => clip(s.replace(/\s+/g, " ").trim(), n);

export async function canvasBrief(
  api: Api,
  userId: string,
  thread: Thread,
  /** How other discussions are read — the store, except under test. */
  load: typeof loadThread = loadThread,
): Promise<string> {
  if (!thread.collectionId || !thread.anchorId) return "";
  const { collection, members } = await api.get<{
    collection: { properties: Record<string, unknown> };
    members: Member[];
  }>(`/collections/${thread.collectionId}`);
  const props = collection.properties ?? {};
  const notes = (Array.isArray(props.canvas_notes) ? props.canvas_notes : []) as Note[];
  const edges = (Array.isArray(props.canvas_edges) ? props.canvas_edges : []) as Edge[];
  const regions = (Array.isArray(props.canvas_regions) ? props.canvas_regions : []) as Region[];

  const memberById = new Map(members.map((m) => [m.id, m]));
  const noteById = new Map(notes.map((n) => [n.id, n]));
  const regionById = new Map(regions.map((r) => [r.id, r]));

  // ── the graph ──────────────────────────────────────────────────────────
  // Undirected: a line on a canvas means "these belong together", whichever
  // end the person started dragging from. A region on the end of a line stands
  // for what is in it — wiring a group to a problem in one stroke is the point
  // of drawing the group — so it is expanded into its members here.
  const expand = (id: string): string[] => regionById.get(id)?.memberIds ?? [id];
  const near = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    if (!near.has(a)) near.set(a, new Set());
    near.get(a)!.add(b);
  };
  for (const e of edges) {
    if (!e.from || !e.to) continue;
    for (const a of expand(e.from)) for (const b of expand(e.to)) {
      link(a, b);
      link(b, a);
    }
  }
  const neighbours = (id: string) => [...(near.get(id) ?? [])];

  const isCloud = (id: string) => !!noteById.get(id)?.chatId;
  const isQuestion = (id: string) =>
    memberById.get(id)?.context?.question === true || noteById.get(id)?.question === true;

  const anchor = thread.anchorId;
  const bubble = thread.noteId;
  // The discussion's own node is a question for this purpose whether or not it
  // is marked: it is what is being asked about.
  const questions = [
    anchor,
    ...[...memberById.keys(), ...noteById.keys()].filter((id) => id !== anchor && isQuestion(id) && !isCloud(id)),
  ];

  // ── naming and describing ─────────────────────────────────────────────
  const types = await api
    .get<{ id: string; name: string; propertySchema: PropertySchema | null }[]>("/block-types")
    .catch(() => []);
  const typeById = new Map(types.map((t) => [t.id, t]));

  const nameOf = (id: string): string => {
    const m = memberById.get(id);
    if (m) {
      const title = typeof m.properties?.title === "string" ? m.properties.title : "";
      const type = m.blockTypeId ? typeById.get(m.blockTypeId)?.name : undefined;
      // With its id: what the model reads here is what it may act on, and a
      // name sends it searching — the first discussion spent eight tool calls
      // looking up a block it had already been given, by a title it had to guess.
      return `${oneLine(title || (m.content ?? "").split("\n")[0] || "Untitled", 100)}${type ? ` (${type})` : ""} [${id}]`;
    }
    const n = noteById.get(id);
    if (n) return n.chatId ? `discussion "${oneLine(n.text ?? "", 80) || "untitled"}"` : `note: ${oneLine(n.text ?? "", 100) || "(empty)"}`;
    return "(unknown)";
  };

  /** Everything a block says, by its own schema's labels. */
  const detail = async (id: string): Promise<string> => {
    const m = memberById.get(id);
    if (!m) {
      const n = noteById.get(id);
      return n?.text?.trim() ? clip(n.text.trim()) : "";
    }
    const lines: string[] = [];
    if (m.content) lines.push(clip(m.content));
    const type = m.blockTypeId ? typeById.get(m.blockTypeId) : undefined;
    const schema = type?.propertySchema ?? null;
    const refTitles = await refTitleMap(api, schema, m.properties ?? {}).catch(() => new Map<string, string>());
    lines.push(...fmtSchemaFields(schema, m.properties ?? {}, [], refTitles), ...fmtExtraProps(schema, m.properties ?? {}));
    return lines.join("\n");
  };
  /** A first line of what a block or note says, for the outline's farther reaches. */
  const gist = (id: string): string => {
    const m = memberById.get(id);
    const text = m ? m.content ?? "" : noteById.get(id)?.text ?? "";
    const first = text.split("\n").find((l) => l.trim()) ?? "";
    return first && !(noteById.get(id) && !m) ? oneLine(first, 140) : "";
  };

  // ── who reaches what ──────────────────────────────────────────────────
  // From each question, breadth first, not passing *through* another question
  // (its neighbourhood is its own outline) and not through discussion clouds
  // (a conversation is not a consideration).
  const reachedBy = new Map<string, Set<string>>(); // node -> questions reaching it
  const trees = new Map<string, Map<string, string[]>>(); // question -> parent -> children
  const meets = new Map<string, Set<string>>(); // question -> other questions it touches
  for (const q of questions) {
    const children = new Map<string, string[]>();
    const seen = new Set([q]);
    let frontier = [q];
    for (let depth = 0; depth < OUTLINE_DEPTH && frontier.length; depth++) {
      const next: string[] = [];
      for (const at of frontier) {
        for (const nb of neighbours(at)) {
          if (seen.has(nb) || nb === bubble || isCloud(nb)) continue;
          seen.add(nb);
          if (questions.includes(nb)) {
            if (!meets.has(q)) meets.set(q, new Set());
            meets.get(q)!.add(nb);
            continue;
          }
          if (!children.has(at)) children.set(at, []);
          children.get(at)!.push(nb);
          if (!reachedBy.has(nb)) reachedBy.set(nb, new Set());
          reachedBy.get(nb)!.add(q);
          next.push(nb);
        }
      }
      frontier = next;
    }
    trees.set(q, children);
  }
  const alsoUnder = (id: string, q: string): string => {
    const others = [...(reachedBy.get(id) ?? [])].filter((x) => x !== q);
    return others.length ? `  (also bears on: ${others.map((x) => nameOf(x)).join("; ")})` : "";
  };

  // ── writing it ────────────────────────────────────────────────────────
  const sections: string[] = [];

  // The discussion's own node, and what is wired straight to it or to the
  // cloud, at full length.
  const close = new Set<string>([...neighbours(anchor), ...(bubble ? neighbours(bubble) : [])]);
  close.delete(anchor);
  if (bubble) close.delete(bubble);
  const own: string[] = [`## The node this discussion is about\n${nameOf(anchor)}${isQuestion(anchor) ? " — a problem or opportunity" : ""}`];
  const anchorDetail = await detail(anchor);
  if (anchorDetail) own.push(anchorDetail);
  const closeLines: string[] = [];
  for (const id of close) {
    if (isCloud(id)) continue;
    const d = await detail(id);
    closeLines.push(`### ${nameOf(id)}${alsoUnder(id, anchor)}${d ? `\n${d}` : ""}`);
  }
  if (closeLines.length) own.push(`## Wired directly to it\n${closeLines.join("\n\n")}`);
  sections.push(own.join("\n\n"));

  // The whole canvas as an outline under its questions.
  const outline: string[] = [];
  for (const q of questions) {
    const children = trees.get(q)!;
    const lines = [`- PROBLEM/OPPORTUNITY: ${nameOf(q)}${q === anchor ? " ← this discussion" : ""}`];
    const g = q === anchor ? "" : gist(q);
    if (g) lines.push(`  ${g}`);
    const walk = (at: string, depth: number) => {
      for (const c of children.get(at) ?? []) {
        const pad = "  ".repeat(depth + 1);
        const line = depth < 2 ? gist(c) : "";
        lines.push(`${pad}- ${nameOf(c)}${alsoUnder(c, q)}${line ? ` — ${line}` : ""}`);
        walk(c, depth + 1);
      }
    };
    walk(q, 0);
    for (const other of meets.get(q) ?? []) lines.push(`  - → also leads to: ${nameOf(other)}`);
    outline.push(lines.join("\n"));
  }
  const reached = new Set([...questions, ...reachedBy.keys()]);
  const elsewhere = [...memberById.keys(), ...noteById.keys()].filter(
    (id) => !reached.has(id) && id !== bubble && !isCloud(id),
  );
  if (elsewhere.length) {
    outline.push(
      `- Elsewhere on the canvas (not connected to any problem or opportunity):\n` +
        elsewhere.map((id) => `  - ${nameOf(id)}`).join("\n"),
    );
  }
  const regionLines = regions
    .filter((r) => r.title?.trim() && r.memberIds?.length)
    .map((r) => `- Group "${oneLine(r.title!, 80)}": ${r.memberIds!.map((id) => nameOf(id)).join("; ")}`);
  sections.push(
    `## The whole canvas, as an outline under its problems and opportunities\n${outline.join("\n")}` +
      (regionLines.length ? `\n\nGroups drawn on the canvas:\n${regionLines.join("\n")}` : ""),
  );

  // Discussions: this node's other clouds in full, the rest as a line each.
  const clouds = notes.filter((n) => n.chatId && n.chatId !== thread.id);
  const siblings = clouds.filter((n) => neighbours(anchor).includes(n.id));
  const distant = clouds.filter((n) => !siblings.includes(n));
  const talk: string[] = [];
  for (const s of siblings) {
    const t = await load(userId, s.chatId!).catch(() => null);
    if (!t || (!t.summary && !t.messages.length)) continue;
    const turns = t.messages
      .slice(-SIBLING_TURNS)
      .map((m) => `${m.role === "user" ? "Person" : "Assistant"}: ${clip(m.content, 1_200)}`);
    talk.push(
      `### "${oneLine(s.text ?? "", 100) || "Untitled discussion"}" (about the same node)\n` +
        (t.summary ? `Summary: ${clip(t.summary, 1_500)}\n` : "") +
        turns.join("\n"),
    );
  }
  for (const s of distant) {
    const about = neighbours(s.id).filter((x) => !isCloud(x)).map((x) => nameOf(x));
    const t = await load(userId, s.chatId!).catch(() => null);
    const last = t?.messages.filter((m) => m.role === "assistant").at(-1)?.content;
    talk.push(
      `- "${oneLine(s.text ?? "", 100) || "Untitled discussion"}"` +
        (about.length ? ` about ${about.join("; ")}` : "") +
        (last ? ` — last answer began: ${oneLine(last, 200)}` : ""),
    );
  }
  if (talk.length) sections.push(`## Other discussions on this canvas\n${talk.join("\n\n")}`);

  // **Say that this is all of it.** Without that, a careful model treats an
  // outline as a lead and goes to check: the first discussion opened with a
  // collection lookup by the outline's own label, three searches and two reads
  // of blocks it already had, before answering from the brief anyway. Tools are
  // for acting on the canvas, or for what is not on it.
  const brief =
    "This conversation lives on a canvas, as a bubble connected to the node it was started from. " +
    "Below is that canvas, complete and current: every node on it, how they connect, and the other " +
    "discussions — read fresh for this message. You do not need to search for it, list its members or " +
    "read its blocks; it is all here. Answer from it, say which pieces you are drawing on, and point out " +
    "when something bears on more than one problem or opportunity. Use tools only to act — create a task, " +
    "update a block — or to look up something that is not on the canvas, and when you act on a block " +
    `here, use the id in [brackets]. The canvas itself is collection [${thread.collectionId}].\n\n` +
    sections.join("\n\n");
  return clip(brief, BRIEF_MAX);
}
