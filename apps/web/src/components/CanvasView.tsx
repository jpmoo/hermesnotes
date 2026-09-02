import { Grid2x2, GripHorizontal, Image as ImageIcon, Minus, Pipette, Plus, Lock, Unlock } from "lucide-react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { readableOn } from "../lib/display.ts";
import { useIsMobile } from "../lib/useIsMobile.ts";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { bodyFieldKey, type FilterGroup } from "@hermes/shared";
import {
  api,
  apiBase,
  type Attachment,
  type Block,
  type BlockSearchResult,
  type BlockType,
  type Collection,
  type Member,
} from "../api.ts";
import { oneLineText } from "../lib/display.ts";
import { emptyGroup } from "../lib/filter.ts";
import { BlockIcon } from "../lib/icons.tsx";
import { emitBlockChange, useBlockDeleted } from "../lib/block-events.ts";
import { captureField, runFieldClipboard, type FieldSelection } from "../lib/field-clipboard.ts";
import { EphemeralNote } from "./EphemeralNote.tsx";
import { PointerMenu } from "./PointerMenu.tsx";
import { usePanels } from "../lib/right-panel.tsx";
import { BlockCard } from "./BlockCard.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { QueryBuilder } from "./QueryBuilder.tsx";

/**
 * Infinite canvas collection: members are boxes placed at membership context
 * {x,y,w,h,color}; ephemeral notes and connections live on the collection
 * (canvas_notes / canvas_edges). Pan by dragging space, zoom by wheel/pinch or
 * the toolbar, connect nodes from the side handles, resize from corners.
 * A canvas is always manually droppable AND query-fed at once — matches of
 * filter_query sync in as placed members; canvas_dismissed suppresses
 * re-adding removed ones.
 */

type Side = "n" | "s" | "e" | "w";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface NodeCtx extends Rect {
  color?: string | null;
  /** See `SHAPES`. Absent means the rounded rectangle everything has always been. */
  shape?: string | null;
  /**
   * Show the block's picture instead of its fields.
   *
   * Furniture, beside the shape and the colour, because it is a fact about this
   * node rather than about the block: the same task can be a card on one canvas
   * and its photograph on another, and neither is the truth about the task.
   */
  showImage?: boolean;
}

/**
 * The outlines a node can wear, as clip paths.
 *
 * Clipped rather than drawn behind. A node here is a live div — typed fields,
 * a title input, a checkbox — and putting an SVG behind it would mean laying
 * out the shape and the content in two coordinate systems that have to agree
 * about padding forever. Clipping keeps one box and one layout.
 *
 * The cost is honest and worth stating: a clip crops. A long title in a
 * triangle loses its corners, exactly as it does in Talaria, because that is
 * what a triangle does to a rectangle of text.
 *
 * `rounded` is absent from the list on purpose — it is the default and is done
 * with `border-radius`, which unlike a clip lets the border draw.
 */
/** What the menu offers, in the order it offers it. Null is the default. */
const SHAPE_CHOICES: { name: string; key: string | null }[] = [
  { name: "Rounded", key: null },
  { name: "Square", key: "rectangle" },
  { name: "Circle", key: "ellipse" },
  { name: "Triangle", key: "triangle" },
  { name: "Post-it", key: "postIt" },
];

const SHAPES: Record<string, string> = {
  rectangle: "inset(0)",
  ellipse: "ellipse(50% 50% at 50% 50%)",
  triangle: "polygon(50% 0%, 100% 100%, 0% 100%)",
  // The cut corner of a sticky. The turned-up flap is drawn over it below.
  postIt: "polygon(0 0, 100% 0, 100% 78%, 78% 100%, 0 100%)",
};
export interface CanvasEdge {
  id: string;
  from: string; // block id or ephemeral "n:<id>"
  to: string;
  fromSide: Side;
  toSide: Side;
  label?: string;
  dash?: "solid" | "dashed" | "dotted";
  width?: number;
  color?: string;
  arrow?: "none" | "forward" | "back" | "both";
  /**
   * How far the middle of the line has been pulled off its natural path.
   *
   * An offset, not a place — the same shape Talaria stores, and for the same
   * reason: move either end and a stored *point* stays behind, hanging off
   * nothing, while a stored *pull* travels with what it connects.
   */
  bendX?: number;
  bendY?: number;
  /** Live edges are real connections (surface in the info block); ephemeral
   * ones are canvas-only decoration. Absent = live (pre-flag edges). */
  live?: boolean;
}
interface CanvasNote extends Rect {
  id: string; // "n:<uuid>"
  text: string;
  color?: string | null;
  /** A sticky can wear an outline too — see `SHAPES`. */
  shape?: string | null;
}
interface CanvasRegion {
  id: string;
  title: string;
  color?: string;
  memberIds: string[];
  /** A collection mirroring this region: canvas add/remove keeps it updated. */
  linkedCollectionId?: string | null;
}

const DEFAULT_W = 280;
const DEFAULT_H = 190;
const NOTE_W = 200;
const NOTE_H = 120;
// Ephemeral notes are opaque sticky notes — post-it yellow by default so one
// never renders see-through (a note created without a color still gets this).
const NOTE_COLOR = "#fdf3d8";
/** How much canvas the edge layer covers, centered on the origin. Generous
 *  enough that nothing is ever drawn outside it, small enough to stay cheap. */
const EDGE_SPAN = 20000;
const MIN_W = 140;
const MIN_H = 80;
// Two rows: the pale papers a card is normally written on, and a muted set for
// when a canvas has enough cards that color has to carry meaning. Both stay
// light enough for dark text, which is what the node styling assumes.
const NODE_COLORS = ["#ffffff", "#fdf3d8", "#e7f1e4", "#e3edf5", "#f5e3e7", "#ece5f6", "#eef4f6"];
const NODE_COLORS_MUTED = ["#e4d9b8", "#c9d8c4", "#bfd0dd", "#ddc3c9", "#cfc6e0", "#c8d6da", "#d6d3ce"];
const REGION_COLORS = [
  "rgba(95, 164, 181, 0.12)",
  "rgba(222, 184, 72, 0.14)",
  "rgba(47, 109, 79, 0.10)",
  "rgba(181, 82, 95, 0.10)",
  "rgba(106, 90, 205, 0.10)",
];
// The same five at roughly twice the strength, for a region that needs to read
// as a place rather than a tint.
const REGION_COLORS_MUTED = [
  "rgba(95, 164, 181, 0.26)",
  "rgba(222, 184, 72, 0.30)",
  "rgba(47, 109, 79, 0.22)",
  "rgba(181, 82, 95, 0.22)",
  "rgba(106, 90, 205, 0.22)",
];

const REGION_PAD = 22;
const REGION_TOP = 44;
const EDGE_COLORS = ["#5f6b74", "#5fa4b5", "#b5525f", "#2f6d4f", "#8a6d1f", "#6a5acd"];

const uid = () => crypto.randomUUID();

/** Side anchor point of a rect. */
function anchor(r: Rect, side: Side): { x: number; y: number } {
  switch (side) {
    case "n":
      return { x: r.x + r.w / 2, y: r.y };
    case "s":
      return { x: r.x + r.w / 2, y: r.y + r.h };
    case "w":
      return { x: r.x, y: r.y + r.h / 2 };
    case "e":
      return { x: r.x + r.w, y: r.y + r.h / 2 };
  }
}
const OUT: Record<Side, { x: number; y: number }> = {
  n: { x: 0, y: -1 },
  s: { x: 0, y: 1 },
  w: { x: -1, y: 0 },
  e: { x: 1, y: 0 },
};

/** The side of `a` that faces `b`'s center. Used as a fallback for edges that
 * arrive without explicit sides (e.g. canvas_create over MCP, which only knows
 * from/to), so a bare {from,to} edge still routes sensibly instead of crashing. */
function facingSide(a: Rect, b: Rect): Side {
  const dx = b.x + b.w / 2 - (a.x + a.w / 2);
  const dy = b.y + b.h / 2 - (a.y + a.h / 2);
  return Math.abs(dx) / a.w > Math.abs(dy) / a.h ? (dx > 0 ? "e" : "w") : dy > 0 ? "s" : "n";
}

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w + 24 && a.x + a.w + 24 > b.x && a.y < b.y + b.h + 24 && a.y + a.h + 24 > b.y;

/** First non-overlapping spot near `cx,cy`, scanning an expanding grid. */
function findSpot(cx: number, cy: number, w: number, h: number, taken: Rect[]): { x: number; y: number } {
  for (let ring = 0; ring < 24; ring++) {
    const step = 70;
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const cand = { x: cx + dx * step - w / 2, y: cy + dy * step - h / 2, w, h };
        if (!taken.some((t) => overlaps(cand, t))) return { x: cand.x, y: cand.y };
      }
    }
  }
  return { x: cx - w / 2, y: cy - h / 2 };
}

export function CanvasView({
  collection,
  members,
  types,
  onChanged,
}: {
  collection: Collection;
  members: Member[];
  types: BlockType[];
  onChanged: () => void;
}) {
  const cid = collection.id;
  const props = collection.properties as Record<string, unknown>;
  const { selectBlock, bottomSlotEl, selectedBlockId } = usePanels();
  const nav = useNavigate();
  const isMobile = useIsMobile();

  // Locked: pan/zoom + selecting and editing block contents stay live, but no
  // structural editing (move/resize/connect/create/region/menus/clear). Phones
  // are always locked — the canvas has too many affordances for touch.
  const [lockPref, setLockPref] = useState<boolean>(() => {
    try {
      return localStorage.getItem("hn.canvas.locked") === "1";
    } catch {
      return false;
    }
  });
  const [grid, setGrid] = useState(() => {
    try {
      return localStorage.getItem("hn.canvas.grid") !== "0";
    } catch {
      return true;
    }
  });
  const toggleGrid = () =>
    setGrid((g) => {
      const next = !g;
      try {
        localStorage.setItem("hn.canvas.grid", next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });

  const locked = isMobile || lockPref;
  const toggleLock = () => {
    setLockPref((v) => {
      const next = !v;
      try {
        localStorage.setItem("hn.canvas.locked", next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  // Transient feedback: a toast for quick acts, a dialog for created collections.
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();
  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  };
  const [createdCollection, setCreatedCollection] = useState<{ id: string; title: string; kind: string } | null>(null);
  const typeById = useMemo(() => new Map(types.map((t) => [t.id, t])), [types]);

  // When a live link connects a block to another whose type matches one of the
  // source's reference (relation) fields, file the source under the target —
  // e.g. linking a task to a project sets the task's Project relation, so the
  // task becomes part of that project. Returns true when the link maps to a
  // relation (so the caller sets the data instead of drawing a standalone edge:
  // the connection then shows as a toggleable "existing" link tied to the
  // relation, and disappears if the relation is later removed).
  const fileUnderRelation = (fromId: string, toId: string): boolean => {
    const from = members.find((m) => m.id === fromId);
    const to = members.find((m) => m.id === toId);
    if (!from || !to || !to.blockTypeId) return false;
    const schema = from.blockTypeId ? typeById.get(from.blockTypeId)?.propertySchema : null;
    const field = schema?.fields.find((f) => f.type === "reference" && f.refTypeId === to.blockTypeId);
    if (!field) return false;

    const target = oneLineText(to.properties, to.content) || (field.label ?? "the target");
    // This connection is a relation, shown only under "Show connections" — turn
    // that on now (if off) and say so, so the drawn line doesn't seem to vanish.
    const revealed = !showLinks;
    if (revealed) {
      setShowLinks(true);
      persistProps({ canvas_show_links: true });
    }
    const vis = `Shows as a connection${revealed ? " — turned Show connections on" : ""}.`;

    const cur = from.properties[field.key];
    const arr = Array.isArray(cur) ? cur.map(String) : typeof cur === "string" && cur ? [cur] : [];
    if (arr.includes(to.id)) {
      showToast(`Already linked to ${target}. ${vis}`);
      return true;
    }
    void api
      .patch(`/blocks/${from.id}`, {
        properties: { ...from.properties, [field.key]: [...arr, to.id] },
        version: from.version,
      })
      .then(() => {
        emitBlockChange(from.id, "canvas-edges");
        showToast(`Added to ${target}. ${vis}`);
      })
      .catch(() => showToast(`Couldn't link to ${target} — reload and try again.`));
    return true;
  };
  const wrapRef = useRef<HTMLDivElement>(null);

  // Fill the viewport: measure where the canvas actually starts and take the
  // rest (the CSS calc() is only a first-paint fallback).
  // Which element owns the swipe in progress, and when it was last fed.
  const wheelGesture = useRef<{ el: HTMLElement | null; at: number }>({ el: null, at: 0 });
  const [wrapH, setWrapH] = useState<number | null>(null);
  useEffect(() => {
    const measure = () => {
      const el = wrapRef.current;
      if (!el) return;
      // Down to the bottom of the window, less a hair so the border isn't flush
      // with the edge. Measured rather than guessed at, because what sits above
      // a canvas varies: a banner, a title, a toolbar, none of them.
      setWrapH(Math.max(460, window.innerHeight - el.getBoundingClientRect().top - 12));
    };
    measure();
    window.addEventListener("resize", measure);
    // Anything above the canvas changing height moves its top edge: a banner
    // finishing loading, a panel being pinned, a title wrapping to two lines.
    // Measuring only on mount left the canvas short by however much arrived late.
    const ro = new ResizeObserver(measure);
    if (wrapRef.current?.parentElement) ro.observe(wrapRef.current.parentElement);
    ro.observe(document.body);
    return () => {
      window.removeEventListener("resize", measure);
      ro.disconnect();
    };
  }, []);

  // ── viewport (persisted locally per canvas) ──
  const VIEW_KEY = `hn.canvas.view.${cid}`;
  const [view, setView] = useState<{ x: number; y: number; z: number }>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(VIEW_KEY) || "");
      if (typeof v?.z === "number") return v;
    } catch {
      /* fresh */
    }
    return { x: 0, y: 0, z: 1 };
  });
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(view));
    } catch {
      /* ignore */
    }
  }, [view, VIEW_KEY]);

  /** Screen → canvas coordinates. */
  const toCanvas = (sx: number, sy: number) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: (sx - r.left - view.x) / view.z, y: (sy - r.top - view.y) / view.z };
  };
  const viewCenter = () => {
    const r = wrapRef.current?.getBoundingClientRect();
    return toCanvas((r?.left ?? 0) + (r?.width ?? 800) / 2, (r?.top ?? 0) + (r?.height ?? 500) / 2);
  };

  // ── nodes / notes / edges ──
  const ctxOf = (m: Member): NodeCtx | null => {
    const c = m.context as Partial<NodeCtx> | undefined;
    return typeof c?.x === "number" && typeof c?.y === "number"
      ? {
          x: c.x,
          y: c.y,
          w: c.w ?? DEFAULT_W,
          h: c.h ?? DEFAULT_H,
          color: c.color ?? null,
          shape: c.shape ?? null,
          showImage: c.showImage === true,
        }
      : null;
  };
  // Local position overrides (during + after drags) layered over member context.
  const [local, setLocal] = useState<Record<string, NodeCtx>>({});
  const [notes, setNotes] = useState<CanvasNote[]>(() =>
    Array.isArray(props.canvas_notes)
      ? // Backfill a color on any note lacking one (e.g. an older AI-created
        // note) so it renders as a solid sticky, never transparent.
        (props.canvas_notes as CanvasNote[]).map((n) => ({ ...n, color: n.color || NOTE_COLOR }))
      : [],
  );
  const [edges, setEdges] = useState<CanvasEdge[]>(() =>
    Array.isArray(props.canvas_edges)
      ? // Edges from canvas_create (MCP) are bare {from,to}; backfill an id so
        // edge selection/patching keys correctly. Missing sides are resolved
        // geometrically at render time (see edgePath).
        (props.canvas_edges as CanvasEdge[]).map((e) => (e.id ? e : { ...e, id: uid() }))
      : [],
  );
  const [regions, setRegions] = useState<CanvasRegion[]>(() =>
    Array.isArray(props.canvas_regions) ? (props.canvas_regions as CanvasRegion[]) : [],
  );
  // "Show existing connections": overlay a solid directional arrow between any
  // two boxes whose underlying blocks already link (persisted per-canvas).
  const [showLinks, setShowLinks] = useState<boolean>(() => props.canvas_show_links === true);
  const [linkPairs, setLinkPairs] = useState<{ from: string; to: string }[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const persistTimer = useRef<ReturnType<typeof setTimeout>>();
  const pendingPatch = useRef<Record<string, unknown>>({});
  // Merge patches: notes/edges/regions often save back-to-back within one
  // debounce window, and a replacing patch would drop the earlier one.
  const persistProps = (patch: Record<string, unknown>) => {
    Object.assign(pendingPatch.current, patch);
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      const p = pendingPatch.current;
      pendingPatch.current = {};
      void api.patch(`/collections/${cid}`, p);
    }, 500);
  };
  const saveNotes = (next: CanvasNote[]) => {
    setNotes(next);
    persistProps({ canvas_notes: next });
  };
  const saveEdges = (next: CanvasEdge[]) => {
    // Ping both endpoints of every edge that changed so an open info pane
    // refreshes its "Connected on canvas" list right away.
    const before = new Map(edges.map((e) => [e.id, JSON.stringify(e)]));
    const after = new Map(next.map((e) => [e.id, JSON.stringify(e)]));
    const touched = new Set<string>();
    for (const e of [...edges, ...next]) {
      if (before.get(e.id) !== after.get(e.id)) {
        if (!e.from.startsWith("n:")) touched.add(e.from);
        if (!e.to.startsWith("n:")) touched.add(e.to);
      }
    }
    setEdges(next);
    persistProps({ canvas_edges: next });
    for (const id of touched) emitBlockChange(id, "canvas-edges");
  };
  const saveRegions = (next: CanvasRegion[]) => {
    setRegions(next);
    persistProps({ canvas_regions: next });
  };
  const patchRegion = (id: string, patch: Partial<CanvasRegion>) =>
    saveRegions(regions.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const toggleShowLinks = () => {
    const next = !showLinks;
    setShowLinks(next);
    persistProps({ canvas_show_links: next });
  };
  // Fetch the directed links among the current member set (re-scans on add).
  useEffect(() => {
    if (!showLinks) {
      setLinkPairs([]);
      return;
    }
    const ids = members.map((m) => m.id);
    if (ids.length < 2) {
      setLinkPairs([]);
      return;
    }
    let canceled = false;
    void api
      .post<{ pairs: { from: string; to: string }[] }>("/blocks/links", { ids })
      .then((r) => !canceled && setLinkPairs(r.pairs))
      .catch(() => !canceled && setLinkPairs([]));
    return () => {
      canceled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showLinks, members]);
  // Pairs already joined by a user-drawn (live) edge — don't double-draw them.
  const drawnPairs = useMemo(() => {
    const s = new Set<string>();
    for (const e of edges) {
      if (e.live === false || e.from.startsWith("n:") || e.to.startsWith("n:")) continue;
      s.add(`${e.from} ${e.to}`);
      s.add(`${e.to} ${e.from}`);
    }
    return s;
  }, [edges]);

  const rectOf = (id: string): Rect | null => {
    if (id.startsWith("n:")) {
      const n = notes.find((x) => x.id === id);
      return n ? { x: n.x, y: n.y, w: n.w, h: n.h } : null;
    }
    const l = local[id];
    if (l) return l;
    const m = members.find((x) => x.id === id);
    if (m) return ctxOf(m);
    /**
     * A region has a box too, and everything that draws a line asks for one.
     *
     * Last, deliberately. A region's id and a block's cannot collide, but a
     * region is a *derived* box — the extent of what it holds — and asking for
     * it first would mean recomputing a rectangle from its members every time
     * anything looked up a node.
     */
    const rg = regions.find((r) => r.id === id);
    return rg ? regionRect(rg) : null;
  };
  /**
   * Alignment while dragging or resizing: a node's edges and centers look for
   * the same lines on its neighbors, and snap to them when they're within a
   * few pixels ON SCREEN — the tolerance is divided by the zoom, so it feels the
   * same close up as far out. Every line that actually matched is drawn, so what
   * you see is what the node lined up with, not a guess at it.
   *
   * Hold Alt to place something freely.
   */
  const SNAP_PX = 6;
  interface Guide {
    axis: "v" | "h";
    at: number;
    from: number;
    to: number;
  }
  const [guides, setGuides] = useState<Guide[]>([]);

  const rectsExcept = (ids: string[]): Rect[] => {
    const skip = new Set(ids);
    return [
      ...members
        .filter((m) => !skip.has(m.id))
        .map((m) => local[m.id] ?? ctxOf(m))
        .filter((r): r is NodeCtx => r !== null),
      ...notes.filter((n) => !skip.has(n.id)).map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h })),
    ];
  };
  const xLines = (r: Rect) => [r.x, r.x + r.w / 2, r.x + r.w];
  const yLines = (r: Rect) => [r.y, r.y + r.h / 2, r.y + r.h];

  /** The lines `r` now shares with its neighbors, for drawing. */
  const guidesFor = (r: Rect, others: Rect[]): Guide[] => {
    const out: Guide[] = [];
    const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
    for (const o of others) {
      for (const a of xLines(r)) {
        for (const b of xLines(o)) {
          if (near(a, b)) {
            out.push({
              axis: "v",
              at: b,
              from: Math.min(r.y, o.y) - 12,
              to: Math.max(r.y + r.h, o.y + o.h) + 12,
            });
          }
        }
      }
      for (const a of yLines(r)) {
        for (const b of yLines(o)) {
          if (near(a, b)) {
            out.push({
              axis: "h",
              at: b,
              from: Math.min(r.x, o.x) - 12,
              to: Math.max(r.x + r.w, o.x + o.w) + 12,
            });
          }
        }
      }
    }
    return out;
  };

  /**
   * Even spacing. Lining edges up is only half of what the eye is doing in a
   * row of cards — the other half is "is the gap the same as the others?", which
   * is the part that's genuinely hard to judge and tedious to correct.
   *
   * Two cases, both along one axis at a time, and only among nodes that overlap
   * the moving one across that axis (things in the same row, or the same
   * column — a card two rows down isn't part of this spacing):
   *   between — sitting between two others, the gaps either side made equal;
   *   extending — placed after a neighbor at the same gap the run already uses.
   */
  interface Spacing {
    axis: "v" | "h";
    /** The cross-axis line the measure is drawn along. */
    at: number;
    from: number;
    to: number;
    gap: number;
  }
  const [spacings, setSpacings] = useState<Spacing[]>([]);

  const overlaps = (a1: number, a2: number, b1: number, b2: number) => a1 < b2 && b1 < a2;

  /**
   * Along one axis: where to put the moving rect so its gaps match the run, and
   * every gap in that run to draw as proof.
   *
   * The run is all the cards that overlap it across the axis, in order. Two ways
   * to fit into one: sit between two of them with equal gaps either side, or
   * extend it at the same gap the run already uses — and "the gap the run uses"
   * comes from every pair in it, not just the pair nearest the pointer, so a row
   * of six keeps its rhythm rather than only agreeing with its neighbor. The
   * measures are then drawn across EVERY gap of that size in the row: the claim
   * is about the series, so the series is what's shown.
   */
  const evenSpacing = (
    r: Rect,
    others: Rect[],
    axis: "x" | "y",
  ): { at: number; spacings: Spacing[] } | null => {
    const tol = SNAP_PX / view.z;
    const [pos, size, cross, crossSize]: ["x" | "y", "w" | "h", "x" | "y", "w" | "h"] =
      axis === "x" ? ["x", "w", "y", "h"] : ["y", "h", "x", "w"];
    const inLine = others
      .filter((o) => overlaps(o[cross], o[cross] + o[crossSize], r[cross], r[cross] + r[crossSize]))
      .sort((a, b) => a[pos] - b[pos]);
    if (inLine.length < 2) return null;

    const at = Math.round(r[cross] + r[crossSize] / 2);
    const marker = (from: number, to: number): Spacing => ({
      axis: axis === "x" ? "h" : "v",
      at,
      from,
      to,
      gap: Math.round(to - from),
    });
    /** Every gap in the row, once the moving card is placed at `place`. */
    const measuresFor = (place: number, gap: number): Spacing[] => {
      const row = [...inLine, { ...r, [pos]: place } as Rect].sort((a, b) => a[pos] - b[pos]);
      const out: Spacing[] = [];
      for (let i = 0; i < row.length - 1; i++) {
        const a = row[i]!;
        const b = row[i + 1]!;
        const g = b[pos] - (a[pos] + a[size]);
        // Only the gaps that agree with the one being matched — a wider gap
        // elsewhere in the row isn't part of the claim.
        if (g > 0 && Math.abs(g - gap) < 0.5) out.push(marker(a[pos] + a[size], b[pos]));
      }
      return out;
    };

    const before = [...inLine].reverse().find((o) => o[pos] + o[size] <= r[pos] + tol);
    const after = inLine.find((o) => o[pos] >= r[pos] + r[size] - tol);

    // Between two cards: split the space evenly.
    if (before && after) {
      const room = after[pos] - (before[pos] + before[size]);
      const want = before[pos] + before[size] + (room - r[size]) / 2;
      if (room > r[size] && Math.abs(want - r[pos]) < tol) {
        return { at: want, spacings: measuresFor(want, (room - r[size]) / 2) };
      }
    }

    // Otherwise: the gaps this row already uses, commonest first, so one odd
    // spacing somewhere doesn't stop the rest of the row setting the rhythm.
    const tally = new Map<number, number>();
    for (let i = 0; i < inLine.length - 1; i++) {
      const g = Math.round(inLine[i + 1]![pos] - (inLine[i]![pos] + inLine[i]![size]));
      if (g > 0) tally.set(g, (tally.get(g) ?? 0) + 1);
    }
    const candidates = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([g]) => g);

    for (const gap of candidates) {
      if (before) {
        const want = before[pos] + before[size] + gap;
        if (Math.abs(want - r[pos]) < tol) return { at: want, spacings: measuresFor(want, gap) };
      }
      if (after) {
        const want = after[pos] - gap - r[size];
        if (Math.abs(want - r[pos]) < tol) return { at: want, spacings: measuresFor(want, gap) };
      }
    }
    return null;
  };

  /** Nudge a moving rect onto the nearest neighboring line, per axis. */
  const snapMove = (r: Rect, others: Rect[]): Rect => {
    const tol = SNAP_PX / view.z;
    let dx = 0;
    let dy = 0;
    let bx = tol;
    let by = tol;
    for (const o of others) {
      for (const a of xLines(r)) {
        for (const b of xLines(o)) {
          const d = b - a;
          if (Math.abs(d) < bx) {
            bx = Math.abs(d);
            dx = d;
          }
        }
      }
      for (const a of yLines(r)) {
        for (const b of yLines(o)) {
          const d = b - a;
          if (Math.abs(d) < by) {
            by = Math.abs(d);
            dy = d;
          }
        }
      }
    }
    // The grid only where a neighbour did not already claim the axis, which is
    // what "loses every tie" means in practice: `bx` is still the tolerance
    // when nothing matched.
    if (bx === tol) {
      const g = gridSnap(r.x, tol);
      if (g !== null) dx = g - r.x;
    }
    if (by === tol) {
      const g = gridSnap(r.y, tol);
      if (g !== null) dy = g - r.y;
    }
    return { ...r, x: r.x + dx, y: r.y + dy };
  };

  /**
   * The dot grid, which is drawn at 26px and was never snapped to.
   *
   * Offered last everywhere it is offered, and losing every tie, so a box
   * already touching a neighbour's edge is not pulled off it by a grid line the
   * same distance away. Alignment to another card is a thing somebody meant;
   * the grid is a thing they get.
   *
   * Only when the grid is showing. Snapping to lines nobody can see is a canvas
   * that moves in steps for no visible reason.
   */
  const GRID = 26;
  const gridSnap = (v: number, tol: number): number | null => {
    if (!grid) return null;
    const near = Math.round(v / GRID) * GRID;
    return Math.abs(near - v) < tol ? near : null;
  };

  /**
   * The same for a resize, plus matching a neighbor's size outright: a note
   * pulled to nearly the width of the one beside it takes that width exactly,
   * which is the thing you were doing by eye.
   */
  const snapResize = (r: Rect, others: Rect[], corner: string): Rect => {
    const tol = SNAP_PX / view.z;
    const out = { ...r };
    const movingE = corner.includes("e");
    const movingS = corner.includes("s");
    const movingW = corner.includes("w");
    const movingN = corner.includes("n");
    let bw = tol;
    let bh = tol;
    for (const o of others) {
      // Same width / height as a neighbor.
      if (Math.abs(o.w - out.w) < bw) {
        bw = Math.abs(o.w - out.w);
        if (movingW) out.x = out.x + out.w - o.w;
        out.w = o.w;
      }
      if (Math.abs(o.h - out.h) < bh) {
        bh = Math.abs(o.h - out.h);
        if (movingN) out.y = out.y + out.h - o.h;
        out.h = o.h;
      }
      // The edge being dragged, onto a neighbor's line.
      for (const b of xLines(o)) {
        if (movingE && Math.abs(b - (out.x + out.w)) < tol) out.w = Math.max(MIN_W, b - out.x);
        if (movingW && Math.abs(b - out.x) < tol) {
          const right = out.x + out.w;
          out.x = Math.min(b, right - MIN_W);
          out.w = right - out.x;
        }
      }
      for (const b of yLines(o)) {
        if (movingS && Math.abs(b - (out.y + out.h)) < tol) out.h = Math.max(MIN_H, b - out.y);
        if (movingN && Math.abs(b - out.y) < tol) {
          out.h = Math.max(MIN_H, out.y + out.h - b);
          out.y = b;
        }
      }
    }
    // And the grid, for the edge being dragged, when nothing else claimed it.
    // Same rule as a move: offered last, so a card already flush with its
    // neighbour is not pulled off by a dot the same distance away.
    if (bw === tol) {
      if (movingE) {
        const g = gridSnap(out.x + out.w, tol);
        if (g !== null) out.w = Math.max(MIN_W, g - out.x);
      } else if (movingW) {
        const g = gridSnap(out.x, tol);
        if (g !== null) {
          const right = out.x + out.w;
          out.x = g;
          out.w = Math.max(MIN_W, right - g);
        }
      }
    }
    if (bh === tol) {
      if (movingS) {
        const g = gridSnap(out.y + out.h, tol);
        if (g !== null) out.h = Math.max(MIN_H, g - out.y);
      } else if (movingN) {
        const g = gridSnap(out.y, tol);
        if (g !== null) {
          const bottom = out.y + out.h;
          out.y = g;
          out.h = Math.max(MIN_H, bottom - g);
        }
      }
    }
    return out;
  };

  const allRects = (): Rect[] => [
    ...members.map((m) => local[m.id] ?? ctxOf(m)).filter((r): r is NodeCtx => r !== null),
    ...notes,
  ];

  /** Bounding box (with region padding) of the given node ids. */
  const rectFromIds = (ids: string[]): Rect | null => {
    const rs = ids.map(rectOf).filter((r): r is Rect => r !== null);
    if (!rs.length) return null;
    const x1 = Math.min(...rs.map((r) => r.x));
    const y1 = Math.min(...rs.map((r) => r.y));
    const x2 = Math.max(...rs.map((r) => r.x + r.w));
    const y2 = Math.max(...rs.map((r) => r.y + r.h));
    return { x: x1 - REGION_PAD, y: y1 - REGION_TOP, w: x2 - x1 + REGION_PAD * 2, h: y2 - y1 + REGION_TOP + REGION_PAD };
  };
  const regionRect = (rg: CanvasRegion) => rectFromIds(rg.memberIds);
  const inRect = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

  /** Mirror a region change into its linked collection (best-effort). */
  const syncLinked = (rg: CanvasRegion, op: "add" | "remove", nodeId: string) => {
    if (!rg.linkedCollectionId || nodeId.startsWith("n:")) return;
    if (op === "add")
      void api.post(`/collections/${rg.linkedCollectionId}/members`, { blockId: nodeId }).catch(() => {});
    else void api.del(`/collections/${rg.linkedCollectionId}/members/${nodeId}`).catch(() => {});
  };

  // Leaving a region requires a deliberate yank: the member must land beyond
  // the region's PRE-DRAG outline plus this grace margin. Anything closer
  // stays a member, and the region simply reshapes around the new position.
  const REGION_GRACE = 90;
  const inflate = (r: Rect, m: number): Rect => ({ x: r.x - m, y: r.y - m, w: r.w + m * 2, h: r.h + m * 2 });

  /** After a node drag: joins the region it landed in, leaves ones it left. */
  const updateRegionMembership = (nodeId: string, startRegions: Record<string, Rect> = {}) => {
    const r = rectOf(nodeId);
    if (!r) return;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    let changed = false;
    const next = regions
      .map((rg) => {
        const others = rg.memberIds.filter((id) => id !== nodeId);
        const isMember = rg.memberIds.includes(nodeId);
        if (isMember) {
          // Hysteresis: judge against the pre-drag outline (or, failing that,
          // the others' rect), inflated by the grace margin.
          const base = startRegions[rg.id] ?? rectFromIds(others);
          const stays = base ? inRect(inflate(base, REGION_GRACE), cx, cy) : false;
          if (!stays) {
            changed = true;
            syncLinked(rg, "remove", nodeId);
            return { ...rg, memberIds: others };
          }
          return rg;
        }
        // Joining uses the strict current outline — dropping INTO a region
        // should feel precise, not magnetic.
        const base = rectFromIds(others);
        if (base && inRect(base, cx, cy)) {
          changed = true;
          syncLinked(rg, "add", nodeId);
          return { ...rg, memberIds: [...rg.memberIds, nodeId] };
        }
        return rg;
      })
      .filter((rg) => rg.memberIds.length > 0);
    if (changed) saveRegions(next);
  };

  const persistMemberCtx = (blockId: string, ctx: NodeCtx) =>
    void api.patch(`/collections/${cid}/members/${blockId}`, {
      context: { x: ctx.x, y: ctx.y, w: ctx.w, h: ctx.h, color: ctx.color ?? null },
    });

  // ── auto-place members that arrived without a position (+ Add, finder,
  //    accepted query batches) ──
  useEffect(() => {
    const taken = allRects();
    const center = viewCenter();
    for (const m of members) {
      if (ctxOf(m) || local[m.id]) continue;
      const spot = findSpot(center.x, center.y, DEFAULT_W, DEFAULT_H, taken);
      taken.push({ ...spot, w: DEFAULT_W, h: DEFAULT_H });
      const ctx = { x: spot.x, y: spot.y, w: DEFAULT_W, h: DEFAULT_H };
      setLocal((p) => ({ ...p, [m.id]: ctx }));
      persistMemberCtx(m.id, ctx);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members]);

  // ── query: build in the panel, Apply → preview modal → Accept adds ──
  const [filter, setFilter] = useState<FilterGroup>(emptyGroup());
  const [tags, setTags] = useState<string[]>([]);
  const [preview, setPreview] = useState<Block[] | null>(null);
  const [accepting, setAccepting] = useState(false);
  useEffect(() => {
    void api.get<{ name: string }[]>("/tags").then((t) => setTags(t.map((x) => x.name))).catch(() => {});
  }, []);
  const applyQuery = async () => {
    const have = new Set(members.map((m) => m.id));
    const matches = await api.post<Block[]>("/blocks/query", { filterQuery: filter });
    setPreview(matches.filter((b) => b.id !== cid && !have.has(b.id)));
  };
  const acceptPreview = async () => {
    if (!preview) return;
    setAccepting(true);
    try {
      const taken = allRects();
      const center = viewCenter();
      for (const b of preview) {
        const spot = findSpot(center.x, center.y, DEFAULT_W, DEFAULT_H, taken);
        taken.push({ ...spot, w: DEFAULT_W, h: DEFAULT_H });
        await api.post(`/collections/${cid}/members`, {
          blockId: b.id,
          context: { x: spot.x, y: spot.y, w: DEFAULT_W, h: DEFAULT_H },
        });
      }
      setFilter(emptyGroup()); // accepted — the builder resets
      setPreview(null);
      onChanged();
    } finally {
      setAccepting(false);
    }
  };

  // ── pan / zoom ──
  const drag = useRef<
    | { kind: "pan"; sx: number; sy: number; ox: number; oy: number; moved: boolean }
    | { kind: "node"; id: string; dx: number; dy: number; moved: boolean; startRegions: Record<string, Rect> }
    | { kind: "resize"; id: string; corner: string; start: Rect; sx: number; sy: number }
    | { kind: "marquee" }
    | { kind: "region"; id: string; sx: number; sy: number; starts: Record<string, Rect>; moved: boolean }
    | {
        kind: "group";
        ids: string[];
        hit: string; // the node the gesture started on
        sx: number;
        sy: number;
        starts: Record<string, Rect>;
        moved: boolean;
      }
    | null
  >(null);
  const [linking, setLinking] = useState<{ from: string; side: Side; x: number; y: number } | null>(null);
  const linkingRef = useRef(linking);
  linkingRef.current = linking;
  const hoverNode = useRef<string | null>(null);

  // Fully functional updates so rapid wheel events never read a stale zoom
  // (the old closure-over-view version stuttered under fast pinches).
  const zoomBy = (factor: number, sx: number, sy: number) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    const px = sx - rect.left;
    const py = sy - rect.top;
    setView((v) => {
      const z = Math.min(3, Math.max(0.1, v.z * factor));
      return { z, x: px - ((px - v.x) / v.z) * z, y: py - ((py - v.y) / v.z) * z };
    });
  };
  const zoomTo = (nz: number, sx: number, sy: number) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    const px = sx - rect.left;
    const py = sy - rect.top;
    setView((v) => {
      const z = Math.min(3, Math.max(0.1, nz));
      return { z, x: px - ((px - v.x) / v.z) * z, y: py - ((py - v.y) / v.z) * z };
    });
  };

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    // Native listener: React's wheel is passive, and we must preventDefault
    // to stop page scroll / browser zoom. Two-finger swipe pans; pinch
    // (ctrlKey wheel) or ⌘/Ctrl+wheel zooms. Registered once — the handler
    // touches no render state directly.
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomBy(Math.exp(-e.deltaY * 0.014), e.clientX, e.clientY);
        return;
      }
      // One gesture, one target. Whatever a swipe starts on keeps it until the
      // fingers lift: reading down a note and hitting its end used to hand the
      // rest of the same swipe to the canvas, which then slid out from under
      // what you were reading. A pause (no wheel events for a moment) ends the
      // gesture and the next one is free to choose again.
      const GESTURE_GAP_MS = 220;
      const fresh = e.timeStamp - wheelGesture.current.at > GESTURE_GAP_MS;
      wheelGesture.current.at = e.timeStamp;
      if (fresh) {
        // Whatever the pointer is over that can scroll this way owns the swipe.
        // Walk up rather than looking for one known element: an ephemeral note's
        // body IS a textarea, and an imported block's long-text editor scrolls
        // inside itself, so neither shows up as a scrollable .cv-body. Nothing
        // here asks about focus — a wheel doesn't need a caret to scroll.
        let owner: HTMLElement | null = null;
        if (Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
          for (let el = e.target as HTMLElement | null; el && el !== wrapRef.current; el = el.parentElement) {
            if (el.scrollHeight <= el.clientHeight + 1) continue;
            const oy = getComputedStyle(el).overflowY;
            if (oy !== "auto" && oy !== "scroll" && el.tagName !== "TEXTAREA") continue;
            const canDown = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
            const canUp = el.scrollTop > 0;
            if ((e.deltaY > 0 && canDown) || (e.deltaY < 0 && canUp)) {
              owner = el;
              break;
            }
          }
        }
        wheelGesture.current.el = owner;
      }
      // The note scrolls itself (and stops at its end — overscroll-behavior
      // keeps the page out of it too).
      if (wheelGesture.current.el?.isConnected) return;
      e.preventDefault();
      setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Two-finger pinch to zoom + pan on touch (the wrap sets touch-action:none,
  // so the browser won't do it for us). A pinch cancels any in-flight
  // single-finger pan (pinchRef).
  const pinchRef = useRef(false);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const dist = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const mid = (a: Touch, b: Touch) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
    let prev: { d: number; m: { x: number; y: number } } | null = null;
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        pinchRef.current = true;
        drag.current = null; // abandon any pan the first finger began
        prev = { d: dist(e.touches[0]!, e.touches[1]!), m: mid(e.touches[0]!, e.touches[1]!) };
        e.preventDefault();
      }
    };
    const onMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || !prev) return;
      e.preventDefault();
      const d = dist(e.touches[0]!, e.touches[1]!);
      const m = mid(e.touches[0]!, e.touches[1]!);
      const rect = el.getBoundingClientRect();
      const px = m.x - rect.left;
      const py = m.y - rect.top;
      const ppx = prev.m.x - rect.left;
      const ppy = prev.m.y - rect.top;
      const ratio = prev.d > 0 ? d / prev.d : 1;
      setView((v) => {
        const z = Math.min(3, Math.max(0.1, v.z * ratio));
        // The world point under the previous midpoint stays under the new one
        // (zoom about the pinch) and follows the midpoint's travel (pan).
        const wx = (ppx - v.x) / v.z;
        const wy = (ppy - v.y) / v.z;
        return { z, x: px - wx * z, y: py - wy * z };
      });
      prev = { d, m };
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        pinchRef.current = false;
        prev = null;
      }
    };
    el.addEventListener("touchstart", onStart, { passive: false });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Leave whatever field was being typed in. These gestures preventDefault(),
   * which suppresses the blur a press normally causes — so a caret would stay
   * in a note you've stopped writing in, and the next Delete would edit that
   * note instead of removing what you just grabbed.
   */
  const dropCaret = () => {
    const a = document.activeElement as HTMLElement | null;
    if (a?.closest?.(".cv-node")) a.blur();
  };

  /**
   * A field in a node is active only while you're in it, and a canvas selection
   * only while you're on the canvas. Pressing anywhere else — another node, the
   * toolbar, the info panel, the rest of the app — puts both down. Without this
   * a caret left behind in a note went on swallowing keystrokes meant for
   * somewhere else, and a stale selection was still what Delete would remove.
   */
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      const active = document.activeElement as HTMLElement | null;
      const host = active?.closest?.(".cv-node");
      if (host && (!t || !host.contains(t))) active?.blur();
      if (!t || wrapRef.current?.contains(t)) return;
      // The canvas's own menus and dialogs are portalled out of the wrap, but
      // they're still the canvas — and they act on what's selected.
      if (t.closest(".cv-menu, .modal-backdrop")) return;
      setSelected([]);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, []);

  const onBgPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    if (e.target !== e.currentTarget) return;
    e.preventDefault(); // stop text-selection sweeps while panning/selecting
    dropCaret();
    if (e.shiftKey && !locked) {
      const p = toCanvas(e.clientX, e.clientY);
      setMarquee({ x1: p.x, y1: p.y, x2: p.x, y2: p.y });
      drag.current = { kind: "marquee" };
    } else {
      setSelected([]);
      drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, moved: false };
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const startRegionDrag = (id: string, e: ReactPointerEvent) => {
    if (locked) return;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const rg = regions.find((r) => r.id === id);
    if (!rg) return;
    const p = toCanvas(e.clientX, e.clientY);
    const starts: Record<string, Rect> = {};
    for (const mid of rg.memberIds) {
      const r = rectOf(mid);
      if (r) starts[mid] = { ...r };
    }
    drag.current = { kind: "region", id, sx: p.x, sy: p.y, starts, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  /**
   * Land the connection being drawn at a point on screen. Kept apart from the
   * pointer plumbing because what it decides — which side of the target to meet,
   * whether this is a real relation or a note's dotted line — is the interesting
   * part, and it's reached from the window listener above.
   */
  const finishLink = (clientX: number, clientY: number) => {
    const link = linkingRef.current;
    setLinking(null);
    if (!link) return;
    // What's under the pointer, by position. Hover tracking can't be trusted
    // here: enter/leave stop firing for the rest of a drag once a pointer is
    // captured, which touch does implicitly on the first move. Every node
    // carries its id, ephemeral notes included.
    const under = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const target = under?.closest<HTMLElement>("[data-block-id]")?.dataset.blockId ?? hoverNode.current;
    if (!target || target === link.from) return;
    const tr = rectOf(target);
    const src = rectOf(link.from);
    if (!tr || !src) return;
    // Meet the target on the side facing the source anchor.
    const sa = anchor(src, link.side);
    const dxc = sa.x - (tr.x + tr.w / 2);
    const dyc = sa.y - (tr.y + tr.h / 2);
    const toSide: Side =
      Math.abs(dxc) / tr.w > Math.abs(dyc) / tr.h ? (dxc > 0 ? "e" : "w") : dyc > 0 ? "s" : "n";
    // A live link needs two real blocks — anything touching an ephemeral note
    // or a region is forced ephemeral (dotted).
    //
    // A region is not a block: it is a box drawn round some, with no id anything
    // outside this canvas can address. Filing a relation to one would be filing
    // a relation to nothing, and the relation would outlive the region.
    const isRegion = (id: string) => regions.some((r) => r.id === id);
    const eph =
      link.from.startsWith("n:") || target.startsWith("n:") || isRegion(link.from) || isRegion(target);
    // A live link whose target type matches a relation field on the source sets
    // that relation (and reveals it as a toggleable "existing connection")
    // instead of drawing a standalone edge that would linger after the relation
    // is removed. Otherwise, draw the edge.
    if (!eph && fileUnderRelation(link.from, target)) return;
    // Two things are either connected or they aren't — a second line between the
    // same pair says nothing the first doesn't, and they overlap so you can't
    // tell there are two. Drawing one again opens the existing line's settings,
    // which is what you were reaching for anyway.
    const existing = edges.find(
      (e) => (e.from === link.from && e.to === target) || (e.from === target && e.to === link.from),
    );
    if (existing) {
      setEdgeMenu({ id: existing.id, x: clientX, y: clientY });
      return;
    }
    const edgeId = uid();
    saveEdges([
      ...edges,
      {
        id: edgeId,
        from: link.from,
        to: target,
        fromSide: link.side,
        toSide,
        arrow: "forward",
        live: !eph,
        ...(eph ? { dash: "dotted" as const } : {}),
      },
    ]);
    // The line's own settings, where it was dropped: dashes, arrows and label
    // are decisions you've just made, and right-clicking the line afterwards is
    // a step people don't find.
    setEdgeMenu({ id: edgeId, x: clientX, y: clientY });
  };

  /**
   * Drawing a connection is a gesture on the WINDOW, not on the canvas element.
   * Relying on the move and the release reaching the canvas meant anything that
   * took them away — a native drag starting, the pointer crossing out of the
   * canvas, an element between us and it — ended the gesture with no line, no
   * error and nothing to go on. The window sees every one of them.
   *
   * Everything the finish needs is read from refs at release time, so the
   * listeners can be attached once for the gesture rather than re-attached on
   * every move.
   */
  useEffect(() => {
    if (!linking) return;
    const move = (e: PointerEvent) => {
      const p = toCanvas(e.clientX, e.clientY);
      setLinking((l) => (l ? { ...l, x: p.x, y: p.y } : l));
    };
    const up = (e: PointerEvent) => finishLink(e.clientX, e.clientY);
    const cancel = () => setLinking(null);
    // A native drag would steal the pointer mid-gesture; there's nothing on a
    // canvas worth dragging that way.
    const noDrag = (e: Event) => e.preventDefault();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLinking(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("dragstart", noDrag);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("dragstart", noDrag);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(linking)]);

  const onPointerMove = (e: ReactPointerEvent) => {
    if (pinchRef.current) return;
    if (linking) return; // the window owns this gesture
    const d = drag.current;
    if (!d) return;
    if (d.kind === "pan") {
      const nx = d.ox + (e.clientX - d.sx);
      const ny = d.oy + (e.clientY - d.sy);
      if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 3) d.moved = true;
      setView((v) => ({ ...v, x: nx, y: ny }));
    } else if (d.kind === "node") {
      const p = toCanvas(e.clientX, e.clientY);
      d.moved = true;
      const cur = rectOf(d.id);
      if (!cur) return;
      const free = { ...cur, x: p.x - d.dx, y: p.y - d.dy };
      const others = e.altKey ? [] : rectsExcept([d.id]);
      const snapped = others.length ? snapMove(free, others) : free;
      // Alignment first; even spacing only where the axis is still free, so the
      // two can't fight over the same pixel.
      const marks: Spacing[] = [];
      if (others.length) {
        if (snapped.x === free.x) {
          const even = evenSpacing(snapped, others, "x");
          if (even) {
            snapped.x = even.at;
            marks.push(...even.spacings);
          }
        }
        if (snapped.y === free.y) {
          const even = evenSpacing(snapped, others, "y");
          if (even) {
            snapped.y = even.at;
            marks.push(...even.spacings);
          }
        }
      }
      setSpacings(marks);
      setGuides(others.length ? guidesFor(snapped, others) : []);
      const ctx = { ...cur, x: snapped.x, y: snapped.y } as NodeCtx;
      if (d.id.startsWith("n:")) setNotes((ns) => ns.map((n) => (n.id === d.id ? { ...n, x: ctx.x, y: ctx.y } : n)));
      else setLocal((prev) => ({ ...prev, [d.id]: ctx }));
    } else if (d.kind === "marquee") {
      const p = toCanvas(e.clientX, e.clientY);
      setMarquee((m) => (m ? { ...m, x2: p.x, y2: p.y } : m));
    } else if (d.kind === "region" || d.kind === "group") {
      const p = toCanvas(e.clientX, e.clientY);
      d.moved = true;
      const dx = p.x - d.sx;
      const dy = p.y - d.sy;
      for (const [mid, start] of Object.entries(d.starts)) {
        if (mid.startsWith("n:"))
          setNotes((ns) => ns.map((n) => (n.id === mid ? { ...n, x: start.x + dx, y: start.y + dy } : n)));
        else
          setLocal((prev) => ({
            ...prev,
            [mid]: { ...((prev[mid] ?? rectOf(mid)) as NodeCtx), x: start.x + dx, y: start.y + dy },
          }));
      }
    } else if (d.kind === "resize") {
      const dx = (e.clientX - d.sx) / view.z;
      const dy = (e.clientY - d.sy) / view.z;
      const r = { ...d.start };
      if (d.corner.includes("e")) r.w = Math.max(MIN_W, d.start.w + dx);
      if (d.corner.includes("s")) r.h = Math.max(MIN_H, d.start.h + dy);
      if (d.corner.includes("w")) {
        r.w = Math.max(MIN_W, d.start.w - dx);
        r.x = d.start.x + (d.start.w - r.w);
      }
      if (d.corner.includes("n")) {
        r.h = Math.max(MIN_H, d.start.h - dy);
        r.y = d.start.y + (d.start.h - r.h);
      }
      const others = e.altKey ? [] : rectsExcept([d.id]);
      if (others.length) {
        const snapped = snapResize(r, others, d.corner);
        Object.assign(r, snapped);
        setGuides(guidesFor(r, others));
      }
      if (d.id.startsWith("n:"))
        setNotes((ns) => ns.map((n) => (n.id === d.id ? { ...n, ...r } : n)));
      else setLocal((prev) => ({ ...prev, [d.id]: { ...(prev[d.id] ?? (r as NodeCtx)), ...r } }));
    }
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    setGuides([]);
    setSpacings([]);
    if (!d) return;
    if (d.kind === "marquee") {
      if (marquee) {
        const mr = {
          x: Math.min(marquee.x1, marquee.x2),
          y: Math.min(marquee.y1, marquee.y2),
          w: Math.abs(marquee.x2 - marquee.x1),
          h: Math.abs(marquee.y2 - marquee.y1),
        };
        const hit = [
          ...members.map((m) => m.id).filter((id) => {
            const r = rectOf(id);
            return r && r.x < mr.x + mr.w && r.x + r.w > mr.x && r.y < mr.y + mr.h && r.y + r.h > mr.y;
          }),
          ...notes
            .filter((n) => n.x < mr.x + mr.w && n.x + n.w > mr.x && n.y < mr.y + mr.h && n.y + n.h > mr.y)
            .map((n) => n.id),
        ];
        setSelected(hit);
        setMarquee(null);
      }
      return;
    }
    if (d.kind === "group") {
      // A press that didn't move is a choice, not a drag: it picks that one node
      // out of the group, which is also how you get back to editing it.
      if (!d.moved) {
        setSelected([d.hit]);
        return;
      }
      persistProps({ canvas_notes: notes });
      for (const gid of d.ids) {
        if (gid.startsWith("n:")) continue;
        const r = rectOf(gid);
        if (r) persistMemberCtx(gid, r as NodeCtx);
      }
      return;
    }
    if (d.kind === "region" && !d.moved) {
      setSelected([d.id]);
      return;
    }
    if (d.kind === "region" && d.moved) {
      const rg = regions.find((r) => r.id === d.id);
      if (rg) {
        persistProps({ canvas_notes: notes });
        for (const mid of rg.memberIds) {
          if (mid.startsWith("n:")) continue;
          const r = rectOf(mid);
          if (r) persistMemberCtx(mid, r as NodeCtx);
        }
      }
      return;
    }
    if (d.kind === "node" && d.moved) {
      const r = rectOf(d.id);
      if (!r) return;
      if (d.id.startsWith("n:")) persistProps({ canvas_notes: notes });
      else persistMemberCtx(d.id, r as NodeCtx);
      updateRegionMembership(d.id, d.startRegions);
    } else if (d.kind === "resize") {
      const r = rectOf(d.id);
      if (!r) return;
      if (d.id.startsWith("n:")) persistProps({ canvas_notes: notes });
      else persistMemberCtx(d.id, r as NodeCtx);
    }
  };

  /**
   * Several nodes selected together stop being documents and become objects:
   * the whole selection moves as one, and a press anywhere on a member starts
   * that move rather than putting a caret in it. Returns the group a node
   * belongs to, or null when it's on its own and behaves normally.
   */
  const groupWith = (id: string) => (selected.length > 1 && selected.includes(id) ? selected : null);

  const startGroupDrag = (ids: string[], hit: string, e: ReactPointerEvent) => {
    if (locked) return;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const p = toCanvas(e.clientX, e.clientY);
    const starts: Record<string, Rect> = {};
    for (const gid of ids) {
      const r = rectOf(gid);
      if (r) starts[gid] = { ...r };
    }
    dropCaret();
    drag.current = { kind: "group", ids, hit, sx: p.x, sy: p.y, starts, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const startNodeDrag = (id: string, e: ReactPointerEvent) => {
    if (locked) return;
    if (e.button !== 0) return;
    const group = groupWith(id);
    if (group) return startGroupDrag(group, id, e);
    // Taking hold of a node selects it (the grip stops propagation, so the
    // node's own press handler never sees this one).
    setSelected([id]);
    dropCaret();
    e.preventDefault();
    e.stopPropagation();
    const p = toCanvas(e.clientX, e.clientY);
    const r = rectOf(id);
    if (!r) return;
    // Remember each containing region's full outline: leaving is judged
    // against where the region WAS, not the shrunken rect of the others.
    const startRegions: Record<string, Rect> = {};
    for (const rg of regions) {
      if (!rg.memberIds.includes(id)) continue;
      const rr = regionRect(rg);
      if (rr) startRegions[rg.id] = rr;
    }
    drag.current = { kind: "node", id, dx: p.x - r.x, dy: p.y - r.y, moved: false, startRegions };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const startResize = (id: string, corner: string, e: ReactPointerEvent) => {
    if (locked) return;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const r = rectOf(id);
    if (!r) return;
    drag.current = { kind: "resize", id, corner, start: { ...r }, sx: e.clientX, sy: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  // ── menus ──
  const [nodeMenu, setNodeMenu] = useState<{
    id: string;
    x: number;
    y: number;
    /** The text field the right-click landed in, if any — see field-clipboard. */
    field: FieldSelection | null;
  } | null>(null);
  const [edgeMenu, setEdgeMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [regionMenu, setRegionMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [syncNewCollection, setSyncNewCollection] = useState(true);
  useEffect(() => {
    if (!nodeMenu && !edgeMenu && !regionMenu) return;
    // pointerdown, not mousedown: canvas drags preventDefault() their
    // pointerdown, which suppresses derived mouse events — a canvas click
    // would never close the menu otherwise.
    const close = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest(".cv-menu")) {
        setNodeMenu(null);
        setEdgeMenu(null);
        setRegionMenu(null);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [nodeMenu, edgeMenu, regionMenu]);

  /** Region → a real collection of its blocks (manual; optionally kept in sync). */
  const createRegionCollection = async (rg: CanvasRegion, kind: string, sync: boolean) => {
    const c = await api.post<Collection>("/collections", {
      kind,
      title: rg.title?.trim() || "Region",
      membershipMode: "explicit",
    });
    for (const mid of rg.memberIds) {
      if (mid.startsWith("n:")) continue; // ephemeral notes aren't blocks
      // Matrix members are invisible without a cell — start them all in the
      // first region; the user arranges from there.
      await api
        .post(`/collections/${c.id}/members`, {
          blockId: mid,
          ...(kind === "matrix" ? { context: { region: 0 } } : {}),
        })
        .catch(() => {});
    }
    if (sync) patchRegion(rg.id, { linkedCollectionId: c.id });
    setCreatedCollection({ id: c.id, title: rg.title?.trim() || "Region", kind });
  };

  // Removal is membership-only — deleting the block itself is the info
  // panel's job, never the canvas's.
  const removeNode = async (id: string) => {
    if (id.startsWith("n:")) {
      saveNotes(notes.filter((n) => n.id !== id));
    } else {
      await api.del(`/collections/${cid}/members/${id}`);
      onChanged();
    }
    saveEdges(edges.filter((e) => e.from !== id && e.to !== id));
  };
  /** A node's current color, for the native picker to open on. */
  const colorOf = (id: string): string | null => {
    if (id.startsWith("n:")) return notes.find((n) => n.id === id)?.color ?? null;
    return (local[id] ?? ctxOf(members.find((m) => m.id === id) ?? ({} as Member)))?.color ?? null;
  };
  /** <input type="color"> only speaks #rrggbb; a region's tints are rgba(). */
  const hexOf = (c: string | null | undefined): string | null =>
    c && /^#[0-9a-f]{6}$/i.test(c.trim()) ? c.trim() : null;

  const setNodeColor = (id: string, color: string | null) => {
    if (id.startsWith("n:")) {
      saveNotes(notes.map((n) => (n.id === id ? { ...n, color } : n)));
    } else {
      const r = rectOf(id) as NodeCtx | null;
      if (!r) return;
      const ctx = { ...r, color };
      setLocal((p) => ({ ...p, [id]: ctx }));
      persistMemberCtx(id, ctx);
    }
  };

  /**
   * The outline a node wears.
   *
   * Stored on the placement, beside its position and colour, because that is
   * what a shape is: furniture. It travels in the member's `context` — the bag
   * the format calls furniture outright and says a consumer may discard — so a
   * canvas read by something that draws no shapes still gets every node in the
   * right place, and Talaria's already uses the same key.
   */
  /**
   * Which blocks have a picture, once anybody has asked.
   *
   * Asked when a node's menu opens rather than for every node on load: a canvas
   * of forty cards would be forty requests to answer a question about one of
   * them, and the answer is only needed where the toggle is drawn.
   *
   * A node already showing its picture asks on sight, because there it is not a
   * menu item — it is the thing being drawn.
   */
  const [pictures, setPictures] = useState<Record<string, Attachment | null>>({});
  const lookForPicture = (id: string) => {
    if (id.startsWith("n:") || id in pictures) return;
    setPictures((p) => ({ ...p, [id]: null })); // claimed, so a second look does not re-ask
    void api
      .get<Attachment[]>(`/blocks/${id}/attachments`)
      .then((all) => {
        const img = all.find((a) => a.mime.startsWith("image/")) ?? null;
        setPictures((p) => ({ ...p, [id]: img }));
      })
      .catch(() => {});
  };

  const setShowImage = (id: string, showImage: boolean) => {
    const r = rectOf(id) as NodeCtx | null;
    if (!r) return;
    const ctx = { ...r, showImage };
    setLocal((p) => ({ ...p, [id]: ctx }));
    persistMemberCtx(id, ctx);
  };

  const setNodeShape = (id: string, shape: string | null) => {
    if (id.startsWith("n:")) {
      saveNotes(notes.map((n) => (n.id === id ? { ...n, shape } : n)));
    } else {
      const r = rectOf(id) as NodeCtx | null;
      if (!r) return;
      const ctx = { ...r, shape };
      setLocal((p) => ({ ...p, [id]: ctx }));
      persistMemberCtx(id, ctx);
    }
  };

  // Bulk removal (Delete key / Clear): regions dissolve (blocks stay unless
  // themselves selected); block removal is membership-only, never deletion.
  // Focusing an ephemeral note edits it in the panel too — without touching
  // selectBlock, so it never lands in the recents history.
  const [ephSel, setEphSel] = useState<string | null>(null);
  // A note just made, waiting for the editor that will hold it to exist. The
  // editor takes the caret when it mounts, so the request is spent by then.
  const [focusNote, setFocusNote] = useState<string | null>(null);
  useEffect(() => {
    if (focusNote) setFocusNote(null);
  }, [focusNote]);
  const [confirmRemove, setConfirmRemove] = useState<string[] | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  /**
   * Removing from a canvas costs different things for different kinds: a block
   * is only taken off the canvas and stays in your notes, a region dissolves
   * and leaves its blocks behind — but an ephemeral note lives nowhere else, so
   * removing it destroys it. The dialog has to say which of those is happening.
   */
  const countRemoval = (ids: string[]) => {
    const regionIds = new Set(regions.map((r) => r.id));
    const nodeIds = ids.filter((id) => !regionIds.has(id));
    return {
      notes: nodeIds.filter((id) => id.startsWith("n:")).length,
      blocks: nodeIds.filter((id) => !id.startsWith("n:")).length,
      regions: ids.length - nodeIds.length,
    };
  };
  const onlyNotes = (ids: string[]) => {
    const c = countRemoval(ids);
    return c.notes > 0 && c.blocks === 0 && c.regions === 0;
  };
  const removalTitle = (ids: string[]) => {
    const c = countRemoval(ids);
    if (onlyNotes(ids)) return c.notes === 1 ? "Delete this note?" : `Delete ${c.notes} notes?`;
    return `Remove ${ids.length} item${ids.length === 1 ? "" : "s"} from the canvas?`;
  };
  const removalMessage = (ids: string[]) => {
    const c = countRemoval(ids);
    const parts: string[] = [];
    if (c.notes)
      parts.push(
        c.notes === 1
          ? "An ephemeral note lives only on this canvas — deleting it is permanent, and it can't be recovered."
          : `${c.notes} ephemeral notes live only on this canvas — deleting them is permanent, and they can't be recovered.`,
      );
    if (c.blocks)
      parts.push(
        `${c.blocks === 1 ? "The block is" : `${c.blocks} blocks are`} only taken off the canvas, not deleted — ${
          c.blocks === 1 ? "it stays" : "they stay"
        } in your notes.`,
      );
    if (c.regions) parts.push("Regions are dissolved; the blocks inside them stay.");
    parts.push("Connections to anything removed go too.");
    return parts.join(" ");
  };

  const removeMany = async (ids: string[]) => {
    const regionIds = new Set(regions.map((r) => r.id));
    const pickedRegions = ids.filter((id) => regionIds.has(id));
    const nodeIds = ids.filter((id) => !regionIds.has(id));
    const noteIds = new Set(nodeIds.filter((id) => id.startsWith("n:")));
    const blockIds = nodeIds.filter((id) => !id.startsWith("n:"));
    if (noteIds.size) saveNotes(notes.filter((n) => !noteIds.has(n.id)));
    saveRegions(
      regions
        .filter((r) => !pickedRegions.includes(r.id))
        .map((r) => ({ ...r, memberIds: r.memberIds.filter((m) => !nodeIds.includes(m)) }))
        .filter((r) => r.memberIds.length > 0),
    );
    saveEdges(edges.filter((e) => !nodeIds.includes(e.from) && !nodeIds.includes(e.to)));
    for (const b of blockIds) await api.del(`/collections/${cid}/members/${b}`).catch(() => {});
    setSelected([]);
    if (blockIds.length) onChanged();
  };
  const clearCanvas = async () => {
    saveNotes([]);
    saveEdges([]);
    saveRegions([]);
    for (const m of members) await api.del(`/collections/${cid}/members/${m.id}`).catch(() => {});
    setSelected([]);
    onChanged();
  };

  // Delete removes the selection (confirmed); ⌘/Ctrl-A selects everything.
  // Ignored while typing in any input/editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest?.("input, textarea, select, [contenteditable=true]")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelected([...members.map((m) => m.id), ...notes.map((n) => n.id)]);
      } else if ((e.key === "Delete" || e.key === "Backspace") && selected.length > 0) {
        e.preventDefault();
        setConfirmRemove([...selected]);
      } else if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        const step = 80;
        const dx = e.key === "ArrowLeft" ? step : e.key === "ArrowRight" ? -step : 0;
        const dy = e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0;
        setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [members, notes, selected]);

  // ── inline add: dynamic search, results with icons, Add on click ──
  const [addQ, setAddQ] = useState("");
  const [addResults, setAddResults] = useState<BlockSearchResult[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  useEffect(() => {
    if (!addOpen || !addQ.trim()) {
      setAddResults([]);
      return;
    }
    const t = setTimeout(() => {
      void api
        .get<BlockSearchResult[]>(`/blocks/search?q=${encodeURIComponent(addQ)}`)
        .then(setAddResults)
        .catch(() => setAddResults([]));
    }, 200);
    return () => clearTimeout(t);
  }, [addQ, addOpen]);
  const addFromSearch = async (b: BlockSearchResult) => {
    const taken = allRects();
    const center = viewCenter();
    const spot = findSpot(center.x, center.y, DEFAULT_W, DEFAULT_H, taken);
    await api.post(`/collections/${cid}/members`, {
      blockId: b.id,
      context: { x: spot.x, y: spot.y, w: DEFAULT_W, h: DEFAULT_H },
    });
    onChanged();
    showToast(`Added “${b.label}”.`);
  };

  // A block deleted anywhere: its edges and region memberships evaporate
  // (the member list itself shrinks via CollectionView's subscription).
  useBlockDeleted((bid) => {
    if (edges.some((e) => e.from === bid || e.to === bid))
      saveEdges(edges.filter((e) => e.from !== bid && e.to !== bid));
    if (regions.some((r) => r.memberIds.includes(bid)))
      saveRegions(
        regions
          .map((r) => ({ ...r, memberIds: r.memberIds.filter((m) => m !== bid) }))
          .filter((r) => r.memberIds.length > 0),
      );
  });

  const addNote = (at?: { x: number; y: number }) => {
    const c = at ?? viewCenter();
    const spot = at ? { x: at.x, y: at.y } : findSpot(c.x, c.y, NOTE_W, NOTE_H, allRects());
    const id = `n:${uid()}`;
    saveNotes([...notes, { id, ...spot, w: NOTE_W, h: NOTE_H, text: "", color: NOTE_COLOR }]);
    // An empty sticky exists to be written on, so put the caret in it rather
    // than making the next act a click on what was just asked for.
    setFocusNote(id);
  };

  const convertNote = async (note: CanvasNote, type: BlockType) => {
    const text = note.text.trim();
    const rawFirst = text.split("\n")[0] ?? "";
    // A note is markdown, so its first line may be a heading or a list item.
    // A title field holds plain text, so the marks come off — the body keeps
    // the line as it was written.
    const firstLine = rawFirst
      .replace(/^\s{0,3}(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
      .trim();
    // Everything after the first line is the note's body. It used to be dropped:
    // a typed block took the first line as its title and nothing else, so
    // converting a sticky with anything written under its heading threw that
    // away without saying so.
    const rest = text.slice(rawFirst.length).replace(/^\n+/, "");
    const key = bodyFieldKey(type.propertySchema);
    const body = type.isText
      ? { blockTypeId: type.id, content: text }
      : {
          blockTypeId: type.id,
          properties: {
            title: firstLine || "Untitled",
            ...(rest && key ? { [key]: rest } : {}),
          },
          // A type with no long-text field has nowhere to put prose. Keeping it
          // on the block's own content is a poor second — the card won't show
          // it — but it stays with the block, searchable and readable, rather
          // than being discarded on the way through.
          ...(rest && !key ? { content: rest } : {}),
        };
    const b = await api.post<Block>("/blocks", body);
    await api.post(`/collections/${cid}/members`, {
      blockId: b.id,
      context: { x: note.x, y: note.y, w: note.w, h: note.h, color: note.color ?? null },
    });
    // Remap edges AND region memberships from the ephemeral id to the real
    // block — conversion must not eject the note from its region.
    saveEdges(edges.map((e) => ({
      ...e,
      from: e.from === note.id ? b.id : e.from,
      to: e.to === note.id ? b.id : e.to,
    })));
    if (regions.some((r) => r.memberIds.includes(note.id))) {
      saveRegions(
        regions.map((r) => {
          if (!r.memberIds.includes(note.id)) return r;
          syncLinked(r, "add", b.id); // the real block joins any linked collection
          return { ...r, memberIds: r.memberIds.map((m) => (m === note.id ? b.id : m)) };
        }),
      );
    }
    saveNotes(notes.filter((n) => n.id !== note.id));
    onChanged();
    selectBlock(b.id);
  };

  // ── edge rendering helpers ──
  const edgePath = (e: CanvasEdge): { d: string; mid: { x: number; y: number } } | null => {
    const fr = rectOf(e.from);
    const tr = rectOf(e.to);
    if (!fr || !tr) return null;
    // Which sides a line leaves and arrives on is a fact about where the two
    // things are NOW, not about where they were when it was drawn. The stored
    // sides were a snapshot of that moment: move either end and the line kept
    // leaving from the far side and looping around, which reads as a mistake
    // rather than a connection. Recomputing every render means the ends follow
    // as you drag, and the stored pair stays only as a record of how it started.
    const fromSide = facingSide(fr, tr);
    const toSide = facingSide(tr, fr);
    const a = anchor(fr, fromSide);
    const b = anchor(tr, toSide);
    const ext = 46;
    /**
     * The bend, solved backwards so the curve passes through the handle.
     *
     * A cubic at its halfway mark sits at (a + 3·c1 + 3·c2 + b)/8. Shifting
     * both control points by δ therefore moves that point by ¾δ — so to move
     * the middle of the line by exactly the bend somebody dragged, the controls
     * move by four thirds of it. Putting the bend straight on the controls
     * would leave the line lagging behind the grip, which reads as the drag not
     * quite working.
     */
    const push = 4 / 3;
    const bx = (e.bendX ?? 0) * push;
    const by = (e.bendY ?? 0) * push;
    const c1 = { x: a.x + OUT[fromSide].x * ext + bx, y: a.y + OUT[fromSide].y * ext + by };
    const c2 = { x: b.x + OUT[toSide].x * ext + bx, y: b.y + OUT[toSide].y * ext + by };
    return {
      d: `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`,
      // The real halfway point rather than an approximation of it, because the
      // grip is drawn here and a grip beside its line is a grip you miss.
      mid: { x: (a.x + 3 * c1.x + 3 * c2.x + b.x) / 8, y: (a.y + 3 * c1.y + 3 * c2.y + b.y) / 8 },
    };
  };
  const dashOf = (e: CanvasEdge) => (e.dash === "dashed" ? "9 6" : e.dash === "dotted" ? "2 6" : undefined);

  /**
   * Which line is showing its grip, and which one is being pulled.
   *
   * Hover rather than selection, because an edge here has no selected state to
   * hang it off — clicking one opens its menu. A grip on every line at once
   * would be a canvas of dots.
   */
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  const bendDrag = useRef<{ id: string; sx: number; sy: number; bx: number; by: number } | null>(null);

  const startBend = (e: CanvasEdge, ev: React.PointerEvent) => {
    if (locked) return;
    ev.preventDefault();
    ev.stopPropagation();
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
    bendDrag.current = { id: e.id, sx: ev.clientX, sy: ev.clientY, bx: e.bendX ?? 0, by: e.bendY ?? 0 };
  };
  const moveBend = (ev: React.PointerEvent) => {
    const d = bendDrag.current;
    if (!d) return;
    // Divided by the zoom, so a pull of an inch on the glass is an inch on the
    // canvas whatever it is scaled to.
    const nx = d.bx + (ev.clientX - d.sx) / view.z;
    const ny = d.by + (ev.clientY - d.sy) / view.z;
    // Near enough to straight is straight. A line dragged out and pushed back
    // never quite returns, and a canvas slowly fills with connections that are
    // two points off straight and look like a mistake.
    const snap = Math.hypot(nx, ny) < 6 / view.z;
    patchEdge(d.id, { bendX: snap ? 0 : nx, bendY: snap ? 0 : ny });
  };
  const endBend = () => {
    bendDrag.current = null;
  };

  const patchEdge = (id: string, patch: Partial<CanvasEdge>) =>
    saveEdges(edges.map((e) => (e.id === id ? { ...e, ...patch } : e)));

  // ── render ──
  const zoomPct = Math.round(view.z * 100);
  const menuEdge = edgeMenu ? edges.find((e) => e.id === edgeMenu.id) : null;
  const menuNote = nodeMenu?.id.startsWith("n:") ? notes.find((n) => n.id === nodeMenu.id) : null;
  const orderedTypes = [...types].sort((a, b) =>
    a.isText === b.isText ? a.name.localeCompare(b.name) : a.isText ? -1 : 1,
  );

  const nodeBox = (id: string, r: NodeCtx, body: ReactNode, isNote: boolean) => {
    // A node told to show its picture asks for one on sight: here it is not a
    // menu item that might be needed, it is the thing being drawn.
    if (r.showImage) lookForPicture(id);
    const pic = r.showImage ? pictures[id] : null;
    const shown: ReactNode = pic ? (
      <img
        className="cv-node-image"
        src={`${apiBase}/attachments/${pic.id}`}
        alt={pic.filename}
        draggable={false}
      />
    ) : (
      body
    );
    return (
    <div
      key={id}
      data-block-id={id}
      data-shape={r.shape ?? undefined}
      className={`cv-node${isNote ? " cv-note" : ""}${selected.includes(id) ? " cv-sel" : ""}${
        groupWith(id) ? " cv-group" : ""
      }${r.color ? " cv-shaded" : ""}${r.shape && SHAPES[r.shape] ? " cv-shaped" : ""}`}
      style={{
        left: r.x,
        top: r.y,
        width: r.w,
        height: r.h,
        // A note's color is on its paper (above), so the cut corner shows what's
        // behind the note rather than more note.
        background: isNote ? "transparent" : r.color || "var(--surface)",
        ...(r.shape && SHAPES[r.shape]
          ? {
              clipPath: SHAPES[r.shape],
              // A clipped edge cuts the border off with everything else, so the
              // outline moves inside as a ring. Without this a circle is a
              // rectangle's border clipped to a circle, which is no border at
              // all down the curve.
              border: "none",
              borderRadius: 0,
              boxShadow: `inset 0 0 0 1px var(--border-strong)`,
            }
          : {}),
      }}
      // Anywhere on a grouped node is a grip. The resize corners and connect
      // handles stop propagation, so they keep their own jobs.
      onPointerDown={(e) => {
        const group = groupWith(id);
        if (group) return startGroupDrag(group, id, e);
        // A press on the node itself rather than into its text selects it —
        // that's what makes Delete mean this node. A press into a field is
        // writing, and must leave the selection (and Delete) alone.
        const t = e.target as HTMLElement;
        if (!t.closest?.("input, textarea, select, [contenteditable=true]")) {
          setSelected([id]);
          dropCaret();
        }
      }}
      onPointerEnter={() => (hoverNode.current = id)}
      onPointerLeave={() => (hoverNode.current = hoverNode.current === id ? null : hoverNode.current)}
      onContextMenu={(e) => {
        if (locked) return;
        e.preventDefault();
        e.stopPropagation();
        // Taking over the right-click takes away the browser's own menu, so
        // note what was selected: the menu offers copy/cut/paste itself.
        // Asked here, so the toggle knows whether to appear by the time the
        // menu is drawn.
        lookForPicture(id);
        setNodeMenu({ id, x: e.clientX, y: e.clientY, field: captureField(e.target) });
      }}
    >
      {/* The paper. Separate from the node because a note's corner is cut away,
          and a cut on the node itself would take the connect handles and resize
          corners with it — they sit a few pixels outside its box. */}
      <div
        className="cv-paper"
        // Ink as well as paper. Without a color here the text is whatever the
        // theme's is, and in the dark theme that is nearly white — on a pale
        // sticky, invisible. A note with no color of its own falls through to
        // the stylesheet, since its paper is light in both themes.
        style={isNote ? { background: r.color || "var(--postit)", color: readableOn(r.color) } : undefined}
      >
        <div className="cv-grab" onPointerDown={(e) => startNodeDrag(id, e)} title="Drag to move">
          <GripHorizontal size={13} />
        </div>
        <div className="cv-body">{shown}</div>
      </div>
      {(["nw", "ne", "sw", "se"] as const).map((c) => (
        <span key={c} className={`cv-corner cv-${c}`} onPointerDown={(e) => startResize(id, c, e)} />
      ))}
      {(["n", "s", "e", "w"] as const).map((sd) => (
        <span
          key={sd}
          className={`cv-handle cv-h-${sd}`}
          title="Drag to connect"
          onPointerDown={(e) => {
            if (locked || e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            // Capture, so the events keep coming even if what's under the
            // pointer changes or disappears. They still reach the window, which
            // is where the rest of this gesture lives (see finishLink).
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            const p = toCanvas(e.clientX, e.clientY);
            setLinking({ from: id, side: sd, x: p.x, y: p.y });
          }}
        />
      ))}
    </div>
    );
  };

  return (
    <div
      ref={wrapRef}
      className={`cv-wrap${locked ? " locked" : ""}${grid ? "" : " no-grid"}`}
      // The dot grid is paper, not a backdrop: it takes the view's offset and
      // zoom so it travels with what's drawn on it. Left fixed, panning felt
      // like sliding the cards over a stationary screen rather than moving
      // across a surface — and there was nothing to judge the movement against.
      style={{
        ...(wrapH != null ? { height: wrapH } : {}),
        ["--cv-x" as string]: `${view.x}px`,
        ["--cv-y" as string]: `${view.y}px`,
        ["--cv-z" as string]: view.z,
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        setLinking(null);
        drag.current = null;
        setGuides([]);
        setSpacings([]);
      }}
      onPointerDown={onBgPointerDown}
      onDoubleClick={(e) => {
        if (!locked && e.target === e.currentTarget) addNote(toCanvas(e.clientX, e.clientY));
      }}
    >
      <div className="cv-layer" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
        {regions.map((rg) => {
          const rr = regionRect(rg);
          if (!rr) return null;
          return (
            <div
              key={rg.id}
              // The same attribute a node carries, because `finishLink` finds
              // what a line was dropped on by looking for it. A region without
              // one is a thing you can aim at and never hit.
              data-block-id={rg.id}
              className="cv-region"
              style={{ left: rr.x, top: rr.y, width: rr.w, height: rr.h, background: rg.color ?? REGION_COLORS[0] }}
              onPointerDown={(e) => startRegionDrag(rg.id, e)}
              onContextMenu={(e) => {
                if (locked) return;
                e.preventDefault();
                e.stopPropagation();
                setRegionMenu({ id: rg.id, x: e.clientX, y: e.clientY });
              }}
            >
              <div className="cv-region-title">
                {rg.title || "Region"}
                {rg.linkedCollectionId && <span title="Synced to a collection"> ⟲</span>}
              </div>
              {/* The same four handles a node has, so a region is a place a
                  line can start as well as one it can land on. Without these it
                  could only ever be the far end of a connection somebody drew
                  from a node, which is half a feature. */}
              {!locked &&
                (["n", "s", "e", "w"] as const).map((sd) => (
                  <span
                    key={sd}
                    className={`cv-handle cv-h-${sd}`}
                    title="Drag to connect"
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.preventDefault();
                      // Stopped, or the region's own drag takes the gesture and
                      // the whole group moves instead of a line being drawn.
                      e.stopPropagation();
                      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                      const p = toCanvas(e.clientX, e.clientY);
                      setLinking({ from: rg.id, side: sd, x: p.x, y: p.y });
                    }}
                  />
                ))}
            </div>
          );
        })}
        {/* A real viewport, centered on the canvas origin, rather than a 0×0 one
            painting outside itself. "overflow: visible" on an <svg> root is
            honoured by browsers but not by every engine — one that clips to the
            viewport instead drops every edge, which looks exactly like
            connections not working while the lines are in fact all there. The
            viewBox matches the box, so canvas coordinates still map 1:1 and no
            path maths changes. */}
        <svg
          className="cv-svg"
          width={EDGE_SPAN}
          height={EDGE_SPAN}
          viewBox={`${-EDGE_SPAN / 2} ${-EDGE_SPAN / 2} ${EDGE_SPAN} ${EDGE_SPAN}`}
          style={{ left: -EDGE_SPAN / 2, top: -EDGE_SPAN / 2 }}
        >
          <defs>
            {edges.map((e) => (
              <marker
                key={`m-${e.id}`}
                id={`cv-arrow-${e.id}`}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill={e.color ?? "#5f6b74"} />
              </marker>
            ))}
            <marker
              id="cv-arrow-link"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#5fa4b5" />
            </marker>
          </defs>
          {edges.map((e) => {
            const p = edgePath(e);
            if (!p) return null;
            const arrow = e.arrow ?? "forward";
            return (
              <g key={e.id}>
                <path
                  d={p.d}
                  className="cv-edge-hit"
                  onContextMenu={(ev) => {
                    if (locked) return;
                    ev.preventDefault();
                    setEdgeMenu({ id: e.id, x: ev.clientX, y: ev.clientY });
                  }}
                  onClick={(ev) => !locked && setEdgeMenu({ id: e.id, x: ev.clientX, y: ev.clientY })}
                  onPointerEnter={() => setHoverEdge(e.id)}
                  onPointerLeave={() => setHoverEdge((h) => (h === e.id ? null : h))}
                />
                <path
                  d={p.d}
                  className="cv-edge"
                  stroke={e.color ?? "#5f6b74"}
                  strokeWidth={e.width ?? 2}
                  strokeDasharray={dashOf(e)}
                  markerEnd={arrow === "forward" || arrow === "both" ? `url(#cv-arrow-${e.id})` : undefined}
                  markerStart={arrow === "back" || arrow === "both" ? `url(#cv-arrow-${e.id})` : undefined}
                />
                {e.label && (
                  <text className="cv-edge-label" x={p.mid.x} y={p.mid.y}>
                    {e.label}
                  </text>
                )}
                {/* The grip. Drawn small and aimed at large: the hit circle is
                    three times the visible one, because this is the one control
                    caught on a curve rather than on a box, and the drawn size
                    is set by what looks right on a line. */}
                {!locked && (hoverEdge === e.id || bendDrag.current?.id === e.id) && (
                  <>
                    <circle
                      className="cv-bend"
                      cx={p.mid.x}
                      cy={p.mid.y}
                      r={5 / view.z}
                    />
                    <circle
                      cx={p.mid.x}
                      cy={p.mid.y}
                      r={15 / view.z}
                      fill="transparent"
                      style={{ cursor: "grab" }}
                      onPointerDown={(ev) => startBend(e, ev)}
                      onPointerMove={moveBend}
                      onPointerUp={endBend}
                      onDoubleClick={() => patchEdge(e.id, { bendX: 0, bendY: 0 })}
                    />
                  </>
                )}
              </g>
            );
          })}
          {showLinks &&
            linkPairs.map((pr) => {
              // Skip a pair the user has already drawn an edge for, and any pair
              // whose endpoints aren't both on the canvas.
              if (drawnPairs.has(`${pr.from} ${pr.to}`)) return null;
              if (!rectOf(pr.from) || !rectOf(pr.to)) return null;
              // Reuse the edge geometry with no explicit sides (facingSide picks).
              const p = edgePath({ id: "lk", from: pr.from, to: pr.to, arrow: "forward" } as unknown as CanvasEdge);
              if (!p) return null;
              return (
                <path
                  key={`lk-${pr.from}-${pr.to}`}
                  d={p.d}
                  className="cv-edge cv-edge-link"
                  stroke="#5fa4b5"
                  strokeWidth={2}
                  markerEnd="url(#cv-arrow-link)"
                />
              );
            })}
          {linking &&
            (() => {
              const fr = rectOf(linking.from);
              if (!fr) return null;
              const a = anchor(fr, linking.side);
              return (
                <path
                  d={`M ${a.x} ${a.y} L ${linking.x} ${linking.y}`}
                  className="cv-edge cv-edge-temp"
                  stroke="#5fa4b5"
                  strokeWidth={2}
                  strokeDasharray="6 5"
                />
              );
            })()}
        </svg>

        {members.map((m) => {
          const r = local[m.id] ?? ctxOf(m);
          if (!r) return null;
          return nodeBox(
            m.id,
            r,
            <BlockCard
              block={m as unknown as Block}
              type={m.blockTypeId ? typeById.get(m.blockTypeId) : undefined}
              onConflict={onChanged}
              onDeleted={() => void removeNode(m.id)}
              compact
            />,
            false,
          );
        })}

        {spacings.map((sp, i) => (
          <div
            key={`s${i}`}
            className={`cv-space cv-space-${sp.axis}`}
            style={
              sp.axis === "h"
                ? { left: sp.from, top: sp.at, width: sp.to - sp.from }
                : { top: sp.from, left: sp.at, height: sp.to - sp.from }
            }
          >
            <span className="cv-space-label">{sp.gap}</span>
          </div>
        ))}
        {guides.map((g, i) => (
          <div
            key={i}
            className={`cv-guide cv-guide-${g.axis}`}
            style={
              g.axis === "v"
                ? { left: g.at, top: g.from, height: g.to - g.from }
                : { top: g.at, left: g.from, width: g.to - g.from }
            }
          />
        ))}

        {(() => {
          // While dragging a region member, show where membership ends: the
          // pre-drag outline + grace margin. Crossing it flips to the danger
          // color — release there and the node leaves the region.
          const d = drag.current;
          if (d?.kind !== "node" || !d.moved) return null;
          const r = rectOf(d.id);
          if (!r) return null;
          const cx = r.x + r.w / 2;
          const cy = r.y + r.h / 2;
          return Object.entries(d.startRegions).map(([rgId, base]) => {
            const b = inflate(base, REGION_GRACE);
            const leaving = !inRect(b, cx, cy);
            return (
              <div
                key={`limit-${rgId}`}
                className={`cv-region-limit${leaving ? " leaving" : ""}`}
                style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
              >
                <span className="cv-region-limit-tag">{leaving ? "leaves region" : "stays in region"}</span>
              </div>
            );
          });
        })()}
        {marquee && (
          <div
            className="cv-marquee"
            style={{
              left: Math.min(marquee.x1, marquee.x2),
              top: Math.min(marquee.y1, marquee.y2),
              width: Math.abs(marquee.x2 - marquee.x1),
              height: Math.abs(marquee.y2 - marquee.y1),
            }}
          />
        )}
        {selected.length > 1 &&
          (() => {
            const bb = rectFromIds(selected);
            if (!bb) return null;
            return (
              <button
                className="cv-make-region"
                style={{ left: bb.x, top: bb.y - 34 }}
                onClick={() => {
                  // A node lives in at most one region: pull from others first.
                  const cleaned = regions
                    .map((rg) => ({ ...rg, memberIds: rg.memberIds.filter((id) => !selected.includes(id)) }))
                    .filter((rg) => rg.memberIds.length > 0);
                  saveRegions([
                    ...cleaned,
                    { id: uid(), title: "Region", memberIds: [...new Set(selected)] },
                  ]);
                  setSelected([]);
                  showToast("Region created — right-click it to name, color, or make a collection.");
                }}
              >
                Create region ({selected.length})
              </button>
            );
          })()}
        {notes.map((n) =>
          nodeBox(
            n.id,
            n,
            <EphemeralNote
              text={n.text}
              placeholder="Ephemeral note — right-click to convert"
              autofocus={focusNote === n.id}
              onFocusChange={(f) => f && setEphSel(n.id)}
              onChange={(v) => saveNotes(notes.map((x) => (x.id === n.id ? { ...x, text: v } : x)))}
            />,
            true,
          ),
        )}
      </div>

      {/* inline add search (top left) */}
      <div className="cv-add">
        <input
          className="cv-add-input"
          placeholder="Add a block…"
          value={addQ}
          onFocus={() => setAddOpen(true)}
          onBlur={() => setTimeout(() => setAddOpen(false), 150)}
          onChange={(e) => setAddQ(e.target.value)}
        />
        {addOpen && addQ.trim() && (
          <div className="cv-add-list">
            {addResults
              .filter((b) => !members.some((m) => m.id === b.id) && b.id !== cid)
              .map((b) => {
                const t = b.blockTypeId ? typeById.get(b.blockTypeId) : undefined;
                return (
                  <button
                    key={b.id}
                    className="cv-add-row"
                    // mousedown so the input's blur doesn't kill the click
                    onMouseDown={(e) => {
                      e.preventDefault();
                      void addFromSearch(b);
                    }}
                  >
                    <BlockIcon
                      iconKey={!t || t.isText ? "type" : t.iconKey}
                      color={!t || t.isText ? null : t.iconColor}
                      size={14}
                    />
                    <span className="cv-add-label">{b.label}</span>
                    <span className="cv-add-go">Add</span>
                  </button>
                );
              })}
            {addResults.filter((b) => !members.some((m) => m.id === b.id) && b.id !== cid).length === 0 && (
              <div className="hint" style={{ padding: "7px 10px" }}>No matches.</div>
            )}
          </div>
        )}
      </div>

      {/* toolbar (lower right) */}
      <div className="cv-toolbar">
        {!isMobile && (
          <>
            <button
              className={`icon-btn cv-lock${lockPref ? " on" : ""}`}
              title={lockPref ? "Locked — click to edit" : "Lock canvas (navigation only)"}
              onClick={toggleLock}
            >
              {lockPref ? <Lock size={14} /> : <Unlock size={14} />}
            </button>
            <span className="cv-tb-sep" />
          </>
        )}
        <button
          className={`icon-btn cv-grid-toggle${grid ? " on" : ""}`}
          title={grid ? "Hide the dot grid" : "Show the dot grid"}
          onClick={toggleGrid}
        >
          <Grid2x2 size={14} />
        </button>
        <span className="cv-tb-sep" />
        <button className="icon-btn" title="Zoom out" onClick={() => zoomBy(1 / 1.2, innerWidth / 2, innerHeight / 2)}>
          <Minus size={14} />
        </button>
        <input
          className="cv-zoom"
          value={`${zoomPct}%`}
          onChange={(e) => {
            const n = Number(e.target.value.replace(/[^\d]/g, ""));
            if (n >= 10 && n <= 300) zoomTo(n / 100, innerWidth / 2, innerHeight / 2);
          }}
        />
        <button className="icon-btn" title="Zoom in" onClick={() => zoomBy(1.2, innerWidth / 2, innerHeight / 2)}>
          <Plus size={14} />
        </button>
        {!locked && (
          <>
            <span className="cv-tb-sep" />
            <button className="ghost" onClick={() => setConfirmClear(true)}>
              Clear
            </button>
          </>
        )}
      </div>

      {/* node menu */}
      {nodeMenu &&
        createPortal(
          <PointerMenu x={nodeMenu.x} y={nodeMenu.y}>
            {nodeMenu.field && (nodeMenu.field.text || nodeMenu.field.writable) && (
              <>
                {(
                  [
                    ["Cut", "cut", Boolean(nodeMenu.field.text) && nodeMenu.field.writable],
                    ["Copy", "copy", Boolean(nodeMenu.field.text)],
                    ["Paste", "paste", nodeMenu.field.writable],
                  ] as const
                )
                  .filter(([, , on]) => on)
                  .map(([label, action]) => (
                    <button
                      key={action}
                      className="menu-item"
                      onClick={() => {
                        const f = nodeMenu.field;
                        setNodeMenu(null);
                        if (f) void runFieldClipboard(f, action);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                <div className="menu-sep" />
              </>
            )}
            <div className="cv-menu-row">
              {NODE_COLORS.map((c) => (
                <button
                  key={c}
                  className="cv-swatch"
                  style={{ background: c }}
                  onClick={() => {
                    setNodeColor(nodeMenu.id, c === "#ffffff" ? null : c);
                    setNodeMenu(null);
                  }}
                />
              ))}
            </div>
            <div className="cv-menu-row">
              {NODE_COLORS_MUTED.map((c) => (
                <button
                  key={c}
                  className="cv-swatch"
                  style={{ background: c }}
                  onClick={() => {
                    setNodeColor(nodeMenu.id, c);
                    setNodeMenu(null);
                  }}
                />
              ))}
              {/* Anything else: the system's own picker, which on a Mac is the
                  one with the eyedropper and the palettes people already keep.
                  The menu stays open while it's up — closing it would take the
                  input away and the picker with it. */}
              <label className="cv-swatch cv-swatch-custom" title="Custom color…">
                <Pipette size={12} />
                <input
                  type="color"
                  value={colorOf(nodeMenu.id) ?? "#ffffff"}
                  onChange={(e) => setNodeColor(nodeMenu.id, e.target.value)}
                />
              </label>
            </div>
            {(() => {
              const pic = pictures[nodeMenu.id];
              if (!pic) return null;
              const showing = (rectOf(nodeMenu.id) as NodeCtx | null)?.showImage === true;
              return (
                <>
                  <div className="menu-sep" />
                  <button
                    className="menu-item menu-item-icon"
                    onClick={() => {
                      setShowImage(nodeMenu.id, !showing);
                      setNodeMenu(null);
                    }}
                  >
                    <ImageIcon size={14} />
                    <span>{showing ? "Show text instead of image" : "Show image instead of text"}</span>
                  </button>
                </>
              );
            })()}
            <div className="menu-sep" />
            <div className="hint" style={{ padding: "4px 10px" }}>Shape</div>
            <div className="cv-menu-row">
              {SHAPE_CHOICES.map((c) => (
                <button
                  key={c.name}
                  className="cv-swatch cv-shape-swatch"
                  // The shape decides the swatch's own geometry in CSS. Setting
                  // only a clip path left three of the five identical: `.cv-swatch`
                  // carries a 6px radius, and a clip cannot take a corner radius
                  // off — so rounded, square and post-it were the same blob.
                  data-shape={c.key ?? "rounded"}
                  title={c.name}
                  onClick={() => {
                    setNodeShape(nodeMenu.id, c.key);
                    setNodeMenu(null);
                  }}
                />
              ))}
            </div>
            {menuNote && (
              <>
                <div className="menu-sep" />
                <div className="hint" style={{ padding: "4px 10px" }}>Convert to…</div>
                {orderedTypes.map((t) => (
                  <button
                    key={t.id}
                    className="menu-item menu-item-icon"
                    onClick={() => {
                      void convertNote(menuNote, t);
                      setNodeMenu(null);
                    }}
                  >
                    {/* The same icon the type wears everywhere else. A list of
                        type names with no icons is a list you read; with them it
                        is a list you recognise, and these are the same seven
                        words every time. */}
                    <BlockIcon
                      iconKey={t.isText ? "type" : t.iconKey}
                      color={t.isText ? null : t.iconColor}
                      size={14}
                    />
                    <span>{t.isText ? "Note (text)" : t.name}</span>
                  </button>
                ))}
              </>
            )}
            <div className="menu-sep" />
            <button
              className="menu-item"
              onClick={() => {
                const id = nodeMenu.id;
                setNodeMenu(null);
                setConfirmRemove([id]);
              }}
            >
              {nodeMenu.id.startsWith("n:") ? "Delete note" : "Remove from canvas"}
            </button>
          </PointerMenu>,
          document.body,
        )}

      {/* ephemeral note editor in the panel (no recents entry) */}
      {bottomSlotEl &&
        ephSel &&
        (() => {
          const note = notes.find((n) => n.id === ephSel);
          if (!note) return null;
          return createPortal(
            <>
              <div className="panel-divider" />
              <div className="panel-h">Ephemeral note</div>
              <EphemeralNote
                key={note.id}
                text={note.text}
                onChange={(v) => saveNotes(notes.map((x) => (x.id === note.id ? { ...x, text: v } : x)))}
              />
              <div className="hint" style={{ margin: "6px 0" }}>Convert to…</div>
              <div className="cv-menu-row" style={{ padding: 0 }}>
                {orderedTypes.map((t) => (
                  <button
                    key={t.id}
                    className="seg"
                    onClick={() => {
                      void convertNote(note, t);
                      setEphSel(null);
                    }}
                  >
                    {t.isText ? "Note" : t.name}
                  </button>
                ))}
              </div>
            </>,
            bottomSlotEl,
          );
        })()}

      {/* query builder in the right panel: Apply-driven, never live */}
      {bottomSlotEl &&
        selectedBlockId === cid &&
        createPortal(
          <>
            <div className="panel-divider" />
            <div className="panel-h">Connections</div>
            <label className="cv-showlinks">
              <input type="checkbox" checked={showLinks} onChange={toggleShowLinks} />
              <span>Show existing connections</span>
            </label>
            <p className="hint" style={{ margin: "4px 0 0" }}>
              Draws an arrow between boxes whose blocks already link to each other.
            </p>
            <div className="panel-divider" />
            <div className="panel-h">Add by query</div>
            <QueryBuilder value={filter} onChange={setFilter} types={types} tags={tags} />
            <button
              className="primary"
              style={{ marginTop: 10 }}
              disabled={filter.items.length === 0}
              onClick={() => void applyQuery()}
            >
              Apply…
            </button>
          </>,
          bottomSlotEl,
        )}

      {/* preview modal */}
      {preview &&
        createPortal(
          <div className="modal-backdrop" onClick={() => setPreview(null)}>
            <div className="modal-card" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
              <h2 className="modal-title">
                Add {preview.length} block{preview.length === 1 ? "" : "s"} to the canvas?
              </h2>
              {preview.length === 0 ? (
                <p className="modal-message">Every match is already on the canvas.</p>
              ) : (
                <div className="cv-preview-list">
                  {preview.map((b) => {
                    const t = b.blockTypeId ? typeById.get(b.blockTypeId) : undefined;
                    return (
                      <div className="cv-preview-row" key={b.id}>
                        <BlockIcon
                          iconKey={!t || t.isText ? "type" : t.iconKey}
                          color={!t || t.isText ? null : t.iconColor}
                          size={15}
                        />
                        <span className="cv-preview-label">
                          {oneLineText(b.properties, b.content) || "Untitled"}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="modal-actions">
                <button className="ghost" onClick={() => setPreview(null)}>
                  Cancel
                </button>
                {preview.length > 0 && (
                  <button className="primary" disabled={accepting} onClick={() => void acceptPreview()}>
                    {accepting ? "Adding…" : "Accept"}
                  </button>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}

      {toast && <div className="cv-toast">{toast}</div>}

      {createdCollection &&
        createPortal(
          <div className="modal-backdrop" onClick={() => setCreatedCollection(null)}>
            <div className="modal-card" style={{ maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
              <h2 className="modal-title">Collection created</h2>
              <p className="modal-message">
                “{createdCollection.title}” is now a{" "}
                {createdCollection.kind === "document" ? "spread" : createdCollection.kind} with the
                region's blocks.
              </p>
              <div className="modal-actions">
                <button className="ghost" onClick={() => setCreatedCollection(null)}>
                  Stay here
                </button>
                <button className="primary" onClick={() => nav(`/collections/${createdCollection.id}`)}>
                  Open it
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      <ConfirmDialog
        open={confirmRemove !== null}
        title={removalTitle(confirmRemove ?? [])}
        message={removalMessage(confirmRemove ?? [])}
        confirmLabel={onlyNotes(confirmRemove ?? []) ? "Delete" : "Remove"}
        danger={countRemoval(confirmRemove ?? []).notes > 0}
        onCancel={() => setConfirmRemove(null)}
        onConfirm={() => {
          const ids = confirmRemove ?? [];
          setConfirmRemove(null);
          void removeMany(ids);
        }}
      />
      <ConfirmDialog
        open={confirmClear}
        title="Clear the whole canvas?"
        message="Every block is removed from the canvas (not deleted); ephemeral notes, connections, and regions are discarded."
        confirmLabel="Clear"
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          setConfirmClear(false);
          void clearCanvas();
        }}
      />

      {/* region menu */}
      {regionMenu &&
        (() => {
          const rg = regions.find((r) => r.id === regionMenu.id);
          if (!rg) return null;
          return createPortal(
            <PointerMenu x={regionMenu.x} y={regionMenu.y}>
              <input
                className="cv-edge-label-input"
                placeholder="Region title…"
                value={rg.title}
                onChange={(e) => patchRegion(rg.id, { title: e.target.value })}
              />
              <div className="cv-menu-row">
                {REGION_COLORS.map((c) => (
                  <button
                    key={c}
                    className="cv-swatch"
                    style={{ background: c }}
                    onClick={() => patchRegion(rg.id, { color: c })}
                  />
                ))}
              </div>
              <div className="cv-menu-row">
                {REGION_COLORS_MUTED.map((c) => (
                  <button
                    key={c}
                    className="cv-swatch"
                    style={{ background: c }}
                    onClick={() => patchRegion(rg.id, { color: c })}
                  />
                ))}
                <label className="cv-swatch cv-swatch-custom" title="Custom color…">
                  <Pipette size={12} />
                  <input
                    type="color"
                    value={hexOf(rg.color) ?? "#5fa4b5"}
                    onChange={(e) => patchRegion(rg.id, { color: e.target.value })}
                  />
                </label>
              </div>
              <div className="menu-sep" />
              <div className="hint" style={{ padding: "4px 10px" }}>Create collection from region…</div>
              <label className="cv-menu-row" style={{ cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={syncNewCollection}
                  style={{ width: "auto" }}
                  onChange={(e) => setSyncNewCollection(e.target.checked)}
                />
                <span style={{ fontSize: 12 }}>Keep synced with region</span>
              </label>
              <div className="cv-menu-row">
                {[
                  ["list", "List"],
                  ["document", "Spread"],
                  ["matrix", "Matrix"],
                  ["table", "Table"],
                ].map(([k, label]) => (
                  <button
                    key={k}
                    className="seg"
                    onClick={() => {
                      void createRegionCollection(rg, k!, syncNewCollection);
                      setRegionMenu(null);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="menu-sep" />
              <button
                className="menu-item"
                onClick={() => {
                  saveRegions(regions.filter((r) => r.id !== rg.id));
                  setRegionMenu(null);
                }}
              >
                Delete region (keeps the blocks)
              </button>
            </PointerMenu>,
            document.body,
          );
        })()}

      {/* edge menu */}
      {edgeMenu &&
        menuEdge &&
        createPortal(
          <PointerMenu x={edgeMenu.x} y={edgeMenu.y}>
            <input
              className="cv-edge-label-input"
              placeholder="Label…"
              value={menuEdge.label ?? ""}
              onChange={(e) => patchEdge(menuEdge.id, { label: e.target.value })}
            />
            <div className="cv-menu-row">
              <button
                className={`seg${menuEdge.live !== false ? " active" : ""}`}
                disabled={menuEdge.from.startsWith("n:") || menuEdge.to.startsWith("n:")}
                title={
                  menuEdge.from.startsWith("n:") || menuEdge.to.startsWith("n:")
                    ? "Ephemeral notes can't hold live links — convert the note to a block first"
                    : "A real connection — shows in both blocks' info"
                }
                onClick={() => patchEdge(menuEdge.id, { live: true, dash: "solid" })}
              >
                Live
              </button>
              <button
                className={`seg${menuEdge.live === false ? " active" : ""}`}
                title="Canvas-only decoration — no system connection"
                onClick={() => patchEdge(menuEdge.id, { live: false, dash: "dotted" })}
              >
                Ephemeral
              </button>
            </div>
            <div className="cv-menu-row">
              {(["solid", "dashed", "dotted"] as const).map((d) => (
                <button
                  key={d}
                  className={`seg${(menuEdge.dash ?? "solid") === d ? " active" : ""}`}
                  onClick={() => patchEdge(menuEdge.id, { dash: d })}
                >
                  {d}
                </button>
              ))}
            </div>
            <div className="cv-menu-row">
              {[1, 2, 3, 4].map((w) => (
                <button
                  key={w}
                  className={`seg${(menuEdge.width ?? 2) === w ? " active" : ""}`}
                  onClick={() => patchEdge(menuEdge.id, { width: w })}
                >
                  {w}px
                </button>
              ))}
            </div>
            <div className="cv-menu-row">
              {(["none", "forward", "back", "both"] as const).map((a) => (
                <button
                  key={a}
                  className={`seg${(menuEdge.arrow ?? "forward") === a ? " active" : ""}`}
                  onClick={() => patchEdge(menuEdge.id, { arrow: a })}
                >
                  {a === "none" ? "—" : a === "forward" ? "→" : a === "back" ? "←" : "↔"}
                </button>
              ))}
            </div>
            <div className="cv-menu-row">
              {EDGE_COLORS.map((c) => (
                <button key={c} className="cv-swatch" style={{ background: c }} onClick={() => patchEdge(menuEdge.id, { color: c })} />
              ))}
            </div>
            <div className="menu-sep" />
            <button
              className="menu-item"
              onClick={() => {
                saveEdges(edges.filter((e) => e.id !== menuEdge.id));
                setEdgeMenu(null);
              }}
            >
              Delete connection
            </button>
          </PointerMenu>,
          document.body,
        )}
    </div>
  );
}
