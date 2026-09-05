/*
 * The seam. Hermes' canvas, talking to Talaria's document.
 *
 * `CanvasView.tsx` is forked from Hermes unchanged in shape, and it reads a
 * `Collection` with `properties`, a list of `Member`s with geometry in each
 * one's `context`, and writes through `api.patch("/collections/…")`. Talaria
 * has none of that: it has one file, `canvas.json`, holding `items`, `links`
 * and `regions`, and one endpoint that replaces the whole thing.
 *
 * This module is the translation, and it is deliberately the *only* place that
 * knows both vocabularies — which is what lets the component stay a fork rather
 * than a rewrite. The brief's table, made real:
 *
 *   collection.properties.canvas_notes  ↔  items without a blockId
 *   members, geometry in member.context ↔  items with a blockId
 *   collection.properties.canvas_edges  ↔  links
 *   regions in properties               ↔  regions
 *
 * **What the renderer does not understand, it must not destroy.** The document
 * is held exactly as it arrived and only the three keys above are touched, so a
 * canvas carrying anything this build has never heard of survives a round trip
 * through it. `PUT /canvas/document` is `passthrough` on the daemon's side for
 * the same reason.
 *
 * **`canvas.json` is a contract with a second reader.** Canvas Chat builds and
 * edits canvases through the same file. Whatever is written here has to be
 * exactly what `canvasagent.ts` expects to read, or the chat stops being able
 * to build a canvas — which is a feature that was asked for specifically.
 */

/* ---------------------------------------------------------------- the types
 * Copied from `apps/web/src/api.ts` rather than imported: Hermes runs on a
 * server and Talaria runs on this machine, they are deployed separately, and a
 * build-time dependency between them is the coupling the owner asked not to
 * have. The fork owns its copy.
 */

export interface Block {
  id: string;
  blockTypeId: string;
  collectionKind: string | null;
  content: string | null;
  properties: Record<string, unknown>;
  embeddedAt: string | null;
  embedPending: boolean;
  version: number;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BlockType {
  id: string;
  name: string;
  iconKey: string | null;
  iconColor: string | null;
  iconSource: string;
  showIcon: boolean;
  propertySchema: unknown | null;
  schemaVersion: number;
  isText: boolean;
  builtin: boolean;
  blockCount?: number;
}

export interface Collection {
  id: string;
  collectionKind: string;
  properties: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface Member {
  membershipId: string;
  position: string;
  context: Record<string, unknown>;
  membershipVersion: number;
  id: string;
  blockTypeId: string | null;
  collectionKind: string | null;
  content: string | null;
  properties: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Attachment {
  id: string;
  blockId: string;
  filename: string;
  mime: string;
  size: number;
  createdAt: string;
}

/* ------------------------------------------------------------ the transport
 * XHR, not `fetch`.
 *
 * The Fetch API is not available over `talaria-app://` — Qt gates it on a
 * scheme flag that does not stick in this PySide build, and every call fails as
 * "Failed to fetch", which looks exactly like a dead daemon. The body rides in
 * a header for a second reason recorded in `scheme.py`: reading a real request
 * body segfaults the process.
 */

const ORIGIN = "talaria-app://daemon";

/**
 * Where the daemon is, for the one module that builds a URL itself.
 *
 * `block-events.ts` opens an `EventSource` at `${apiBase}/events` — Hermes'
 * live channel, so a block edited in another tab redraws here. Talaria has no
 * such channel and this is a local file besides: the only other writer is
 * Canvas Chat, through the same daemon. The constant is exported so the fork
 * compiles unchanged; `useLiveSync` is simply never called, and the hooks that
 * listen for its events go quiet rather than wrong.
 */
export const apiBase = ORIGIN;

export function ask<T>(method: string, path: string, body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(method, ORIGIN + path, true);
    if (body !== undefined) {
      x.setRequestHeader("content-type", "application/json");
      x.setRequestHeader("x-talaria-body", JSON.stringify(body));
    }
    x.onload = () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(x.responseText);
      } catch {
        reject(new Error(`${path} did not answer with JSON`));
        return;
      }
      const envelope = parsed as { ok?: boolean; error?: string; message?: string; data?: T };
      if (envelope && (envelope.ok === false || envelope.error)) {
        reject(new Error(envelope.message || envelope.error || "the daemon refused that"));
        return;
      }
      resolve((envelope && "data" in envelope ? envelope.data : parsed) as T);
    };
    x.onerror = () => reject(new Error("can't reach the daemon — is it running?"));
    x.send(null);
  });
}

/* ------------------------------------------------------------- the routing */

import {
  endIn,
  isNoteId,
  noteIdOf,
  putDocument,
  type CanvasDocument,
  type CanvasItem,
  type CanvasLink,
  type CanvasRegion,
} from "./document.ts";

/**
 * The document everything below edits.
 *
 * Held in one place and replaced whole. `main.tsx` loads it, this mutates it,
 * and `flush` writes it back — there is no second copy anywhere, which is the
 * property the daemon's own note asks for.
 */
let held: CanvasDocument = { items: [], links: [], regions: [] };
let onWritten: (() => void) | null = null;

export function hold(doc: CanvasDocument, written: () => void) {
  held = doc;
  onWritten = written;
}
export const document_ = () => held;

/*
 * Written on a pause.
 *
 * A drag is a hundred `patch` calls and the document is a whole file; writing
 * each one would mean a hundred rewrites of the same canvas, and the last one
 * is the only one anybody wants. The trailing edge is what matters, so this is
 * a debounce rather than a throttle — and it is flushed on `pagehide` so a
 * panel closed a tenth of a second after a move still saves it.
 */
let pending: number | null = null;
let writing: Promise<unknown> = Promise.resolve();

function save() {
  if (pending !== null) clearTimeout(pending);
  pending = window.setTimeout(() => {
    pending = null;
    // Chained rather than parallel: two whole-document writes racing is exactly
    // the problem the single-document design exists to avoid.
    writing = writing.then(() => putDocument(held)).then(
      () => onWritten?.(),
      (err) => console.error("canvas: could not save —", err),
    );
  }, 250);
}

export function flush() {
  if (pending !== null) {
    clearTimeout(pending);
    pending = null;
    writing = writing.then(() => putDocument(held));
  }
  return writing;
}
addEventListener("pagehide", () => void flush());

/** Hermes' note shape, back into an item. */
function itemFromNote(note: Record<string, unknown>): CanvasItem {
  return {
    // Back out of the component's vocabulary: `n:<id>` is how it addresses a
    // note, and the file stores the id itself.
    id: noteIdOf(String(note.id)),
    x: Number(note.x) || 0,
    y: Number(note.y) || 0,
    w: Number(note.w) || 160,
    h: Number(note.h) || 80,
    text: typeof note.text === "string" ? note.text : "",
    shape: typeof note.shape === "string" ? note.shape : "plain",
    fill: ((note.color ?? note.fill) as string) ?? null,
    stroke: (note.stroke as string) ?? null,
    strokeWidth: note.strokeWidth as number | undefined,
    strokeStyle: note.strokeStyle as string | undefined,
    hAlign: note.hAlign as string | undefined,
    vAlign: note.vAlign as string | undefined,
    textColor: (note.textColor as string) ?? null,
    image: (note.image as string) ?? null,
  };
}

function linkFromEdge(edge: Record<string, unknown>): CanvasLink {
  return {
    id: String(edge.id),
    from: endIn(held, String(edge.from)),
    to: endIn(held, String(edge.to)),
    bendX: edge.bendX as number | undefined,
    bendY: edge.bendY as number | undefined,
    color: (edge.color as string) ?? null,
    width: edge.width as number | undefined,
    style: edge.dash as string | undefined,
  };
}

/**
 * Properties, written back into the document.
 *
 * Only the three keys this build understands are read out of the patch. A
 * property it has never heard of is left where it was rather than being
 * dropped, which is the same promise the interchange importer makes about
 * unknown fields.
 */
function patchProperties(props: Record<string, unknown>) {
  if (Array.isArray(props.canvas_notes)) {
    const blocks = held.items.filter((i) => i.blockId);
    const notes = (props.canvas_notes as Record<string, unknown>[]).map(itemFromNote);
    held.items = [...blocks, ...notes];
  }
  if (Array.isArray(props.canvas_edges)) {
    held.links = (props.canvas_edges as Record<string, unknown>[]).map(linkFromEdge);
  }
  if (Array.isArray(props.canvas_regions)) {
    held.regions = (props.canvas_regions as Record<string, unknown>[]).map((region) => ({
      id: String(region.id),
      title: typeof region.title === "string" ? region.title : "",
      fill: (region.color as string) ?? null,
      members: ((region.memberIds as string[]) ?? []).map((end) => endIn(held, end)),
    }));
  }
  save();
}

function patchMember(blockId: string, context: Record<string, unknown>) {
  const item = held.items.find((i) => i.blockId === blockId);
  if (!item) return;
  const c = context.context as Record<string, unknown> | undefined;
  const from = c ?? context;
  if (typeof from.x === "number") item.x = from.x;
  if (typeof from.y === "number") item.y = from.y;
  if (typeof from.w === "number") item.w = from.w;
  if (typeof from.h === "number") item.h = from.h;
  if ("fill" in from) item.fill = (from.fill as string) ?? null;
  if ("stroke" in from) item.stroke = (from.stroke as string) ?? null;
  if (typeof from.strokeWidth === "number") item.strokeWidth = from.strokeWidth;
  if (typeof from.strokeStyle === "string") item.strokeStyle = from.strokeStyle;
  if (typeof from.shape === "string") item.shape = from.shape;
  save();
}

function addMember(body: Record<string, unknown>) {
  const blockId = String(body.blockId);
  if (held.items.some((i) => i.blockId === blockId)) return;
  const c = (body.context as Record<string, unknown>) ?? {};
  held.items.push({
    id: `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    x: Number(c.x) || 0,
    y: Number(c.y) || 0,
    w: Number(c.w) || 200,
    h: Number(c.h) || 90,
    blockId,
  });
  save();
}

function dropMember(id: string) {
  // A note and a block are removed the same way from the component's side, so
  // both ends of the vocabulary are accepted here.
  const itemId = isNoteId(id) ? noteIdOf(id) : null;
  held.items = held.items.filter((i) => (itemId ? i.id !== itemId : i.blockId !== id));
  held.links = held.links.filter(
    (l) => held.items.some((i) => i.id === l.from) && held.items.some((i) => i.id === l.to),
  );
  save();
}

class Unsupported extends Error {}

/**
 * The component's `api`, answered locally.
 *
 * Every path the canvas asks for is either a document edit — answered here,
 * with no round trip — or a question only the daemon can answer, which is
 * forwarded. Anything else throws by name rather than silently doing nothing:
 * a canvas that quietly ignores a call is a canvas that loses somebody's work
 * without saying so.
 */
async function route<T>(method: string, path: string, body?: unknown): Promise<T> {
  const at = path.split("?")[0];
  const member = /^\/collections\/[^/]+\/members\/(.+)$/.exec(at);
  const members = /^\/collections\/[^/]+\/members$/.test(at);
  const collection = /^\/collections\/[^/]+$/.test(at);

  if (method === "PATCH" && collection) {
    patchProperties((body ?? {}) as Record<string, unknown>);
    return undefined as T;
  }
  if (method === "PATCH" && member) {
    patchMember(decodeURIComponent(member[1]), (body ?? {}) as Record<string, unknown>);
    return undefined as T;
  }
  if (method === "POST" && members) {
    addMember((body ?? {}) as Record<string, unknown>);
    return undefined as T;
  }
  if (method === "DELETE" && member) {
    dropMember(decodeURIComponent(member[1]));
    return undefined as T;
  }
  if (method === "GET" && at === "/tags") {
    // The tags are what the blocks are wearing, which is also the only list
    // worth offering: a tag nothing carries is not one to pick.
    const spotlight = await ask<{ items: { tags?: string[] }[] }>("GET", "/spotlight");
    const seen = new Set<string>();
    for (const item of spotlight.items ?? []) for (const tag of item.tags ?? []) seen.add(tag);
    return [...seen].sort().map((name) => ({ name })) as T;
  }
  throw new Unsupported(`the canvas asked for ${method} ${at}, which Talaria has no answer for`);
}

export const api = {
  get: <T>(p: string) => route<T>("GET", p),
  post: <T>(p: string, b?: unknown) => route<T>("POST", p, b ?? {}),
  patch: <T>(p: string, b?: unknown) => route<T>("PATCH", p, b ?? {}),
  del: <T>(p: string) => route<T>("DELETE", p),
  upload: <T>(_p: string, _form: FormData): Promise<T> => {
    throw new Unsupported("attachments are not wired up yet");
  },
};
