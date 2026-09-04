import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./config.js";

/**
 * The canvas, as the chat is allowed to touch it.
 *
 * **This file is the whole of what Talaria's own chat can do.** It builds and
 * changes a canvas and nothing else — it cannot write a task, complete one,
 * rename a block, or reach Hermes at all except to *look things up* so it knows
 * what to put on the canvas. That boundary is the feature rather than a
 * limitation to apologise for: the other chat in this app already speaks to
 * Hermes and can change it, and a second one that could do the same thing by a
 * different route would be two ways to do one job and two places to look when
 * something has changed that nobody meant to change.
 *
 * The document is `canvas.json`, the same file the app writes on every drag.
 * One file, one machine, one person — so a write here is a write, with no
 * versions, no merge and no read-set. Every distributed-document problem this
 * project has met came from a canvas that was two documents; this one is one.
 */

export const CANVAS_PATH = join(HOME, "canvas.json");

export interface CanvasItem {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  shape?: string;
  fill?: string | null;
  stroke?: string | null;
  strokeWidth?: number;
  strokeStyle?: string;
  hAlign?: string;
  vAlign?: string;
  textColor?: string | null;
  /** File name of a picture in `canvas-images/`, when this node is one. */
  image?: string | null;
  blockId?: string | null;
}
export interface CanvasLink {
  id: string;
  from: string;
  to: string;
  bendX?: number;
  bendY?: number;
  color?: string | null;
  width?: number;
  style?: string;
}
export interface CanvasRegion {
  id: string;
  members: string[];
  title?: string;
  hAlign?: string;
  textColor?: string | null;
  fill?: string | null;
  stroke?: string | null;
  strokeWidth?: number;
  strokeStyle?: string;
}
export interface CanvasDocument {
  items: CanvasItem[];
  links: CanvasLink[];
  regions: CanvasRegion[];
}

/**
 * The shapes a node can wear. The same words the app stores.
 *
 * This list and the app's `CanvasShape` are one vocabulary in two places, and
 * they had already drifted: `postIt` existed in the app and not here, so the
 * chat could neither make a sticky note nor convert anything into one, and the
 * zod enum refused the word if anybody tried.
 */
export const SHAPES = ["plain", "rectangle", "roundedRectangle", "ellipse", "triangle", "postIt"] as const;

/**
 * What a shape looks like before anybody says otherwise — the same defaults
 * `addText` applies in the app.
 *
 * A post-it is paper: a color, and no line round the edge. Every other shape
 * here *is* an outline. Writing `strokeWidth: 1.5` for all of them, which is
 * what this did, turns a sticky into a line drawing of one.
 */
export function shapeDefaults(shape: string): { fill: string | null; strokeWidth: number } {
  return shape === "postIt"
    ? { fill: "#fdf3b6", strokeWidth: 0 }
    : { fill: null, strokeWidth: 1.5 };
}

const EMPTY: CanvasDocument = { items: [], links: [], regions: [] };

export function readCanvas(): CanvasDocument {
  try {
    const d = JSON.parse(readFileSync(CANVAS_PATH, "utf8")) as Partial<CanvasDocument>;
    return { items: d.items ?? [], links: d.links ?? [], regions: d.regions ?? [] };
  } catch {
    return { ...EMPTY };
  }
}

export function writeCanvas(doc: CanvasDocument): void {
  // Indented, because this file is one somebody opens and reads — the same
  // argument the config file won.
  writeFileSync(CANVAS_PATH, JSON.stringify(doc, null, 1));
}

/** A fresh id in the shape the app's own are: uppercase, hyphenated. */
export function newId(): string {
  return randomUUID().toUpperCase();
}

/**
 * Somewhere to put a new node that is not on top of an existing one.
 *
 * Not a layout engine. It walks a grid outward from the origin and takes the
 * first cell nothing overlaps, which is enough to keep a chat from stacking
 * five nodes in one place — the thing that makes a canvas look broken when
 * something else has arranged it.
 */
export function freeSpot(doc: CanvasDocument, w: number, h: number): { x: number; y: number } {
  const gap = 40;
  const hits = (x: number, y: number) =>
    doc.items.some((i) => x < i.x + i.w + gap && x + w + gap > i.x && y < i.y + i.h + gap && y + h + gap > i.y);
  for (let ring = 0; ring < 40; ring++) {
    for (let col = -ring; col <= ring; col++) {
      for (let row = -ring; row <= ring; row++) {
        if (Math.max(Math.abs(col), Math.abs(row)) !== ring) continue;
        const x = col * (w + gap);
        const y = row * (h + gap);
        if (!hits(x, y)) return { x, y };
      }
    }
  }
  return { x: 0, y: 0 };
}

/**
 * Which node somebody means.
 *
 * By id, or by the words on it. A chat refers to things the way a person does —
 * "the orange one", "Draft the memo" — and an id it has not been given is an id
 * it will invent.
 */
export function findItem(doc: CanvasDocument, nameOrId: string): CanvasItem | undefined {
  const s = nameOrId.trim();
  const byId = doc.items.find((i) => i.id === s || i.id === s.toUpperCase());
  if (byId) return byId;
  const lower = s.toLowerCase();
  return (
    doc.items.find((i) => (i.text ?? "").trim().toLowerCase() === lower) ??
    doc.items.find((i) => (i.text ?? "").toLowerCase().includes(lower))
  );
}

export function findRegion(doc: CanvasDocument, nameOrId: string): CanvasRegion | undefined {
  const s = nameOrId.trim();
  return (
    doc.regions.find((r) => r.id === s || r.id === s.toUpperCase()) ??
    doc.regions.find((r) => (r.title ?? "").trim().toLowerCase() === s.toLowerCase())
  );
}

/**
 * How long a picture is left alone before it counts as unreferenced.
 *
 * A file is uploaded, and only then does a document arrive naming it. Those two
 * are milliseconds apart, but they are two requests, and a sweep landing
 * between them would delete the picture somebody had just dropped. A minute is
 * far longer than that gap and far shorter than anybody would notice.
 */
const IMAGE_GRACE_MS = 60_000;

/**
 * Throw away pictures nothing points at any more.
 *
 * The app leaves them: it only forgets an image when a whole canvas is
 * replaced, so removing a node leaves its picture on disk for good. That is a
 * folder that only grows, holding things no longer reachable by any means.
 *
 * Swept against the live canvas *and* `canvas-replaced.json`, the copy the app
 * puts aside before a destructive load. That archive is the only way back from
 * loading over a canvas, and a way back that has lost its pictures is not one.
 * Worth knowing: the app undermines its own archive here — it writes the copy
 * and then forgets the images the copy refers to — so this is more careful with
 * it than the thing that made it.
 *
 * Best-effort throughout. Failing to delete a file is untidy; failing to save a
 * canvas because a file could not be deleted is not a trade worth making.
 */
export function sweepImages(live: CanvasDocument): number {
  const dir = join(HOME, "canvas-images");
  const keep = new Set<string>();
  const note = (d: CanvasDocument | null) => {
    for (const item of d?.items ?? []) {
      if (typeof item.image === "string" && item.image) keep.add(item.image);
    }
  };
  note(live);
  try {
    note(JSON.parse(readFileSync(join(HOME, "canvas-replaced.json"), "utf8")) as CanvasDocument);
  } catch {
    // No archive, or one that will not parse. Neither is a reason to stop.
  }
  let gone = 0;
  const cutoff = Date.now() - IMAGE_GRACE_MS;
  try {
    for (const name of readdirSync(dir)) {
      if (keep.has(name) || name.startsWith(".")) continue;
      try {
        if (statSync(join(dir, name)).mtimeMs > cutoff) continue;
        unlinkSync(join(dir, name));
        gone += 1;
      } catch {
        /* a file that will not go is left where it is */
      }
    }
  } catch {
    // No folder yet, which means no pictures and nothing to sweep.
  }
  return gone;
}
