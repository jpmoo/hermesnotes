import { Grid2x2, GripHorizontal, Image as ImageIcon, Minus, Pipette, Plus, Lock, Unlock } from "lucide-react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { readableOn } from "../lib/display.ts";
import { keepResized, pictureAt } from "../api.ts";
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
interface NodeCtx extends Rect, TalariaInk {
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
  /**
   * The node's own outline: colour, thickness, style.
   *
   * The same three keys Talaria stores, under the same names, for the same
   * reason `shape` and `color` share theirs — furniture, in the member's
   * context, which the format says a consumer may discard. A canvas read by
   * something that draws no borders still gets every node in the right place.
   *
   * On the sheet, never the frame. The frame carries the handles and the
   * ephemeral mark; a border is part of how the node *looks*, which is the
   * sheet's job.
   */
  stroke?: string | null;
  strokeWidth?: number | null;
  strokeStyle?: string | null;
}

/**
 * The outline of a shape, in the node's own pixels.
 *
 * Drawn rather than bordered, for the shapes that are clipped. A CSS border on
 * a clipped element is cut off with everything else — the same reason clipping
 * the node ate the resize corners — so on an ellipse or a triangle a border
 * simply did not appear, and every width and style looked identical because all
 * of them were invisible.
 *
 * In real units rather than percentages so the sticky's fold stays the fixed
 * 14px it has always been: a fold that scaled with the node would be a
 * different sticky at every size.
 */
const OUTLINE_FOLD = 14;
const outlinePath = (shape: string | null | undefined, w: number, h: number): string | null => {
  const f = Math.min(OUTLINE_FOLD, w / 2, h / 2);
  switch (shape) {
    case "ellipse":
      return `M ${w / 2} 0 A ${w / 2} ${h / 2} 0 1 0 ${w / 2} ${h} A ${w / 2} ${h / 2} 0 1 0 ${w / 2} 0 Z`;
    case "triangle":
      return `M ${w / 2} 0 L ${w} ${h} L 0 ${h} Z`;
    case "postIt":
      return `M 0 0 L ${w} 0 L ${w} ${h - f} L ${w - f} ${h} L 0 ${h} Z`;
    default:
      // Rounded and square are not clipped, so their border is a real border
      // and draws itself.
      return null;
  }
};

/** What a border can be. Talaria's three, so the two canvases agree. */
const BORDER_STYLES = ["solid", "dashed", "double"] as const;
/** Off, hairline, and two weights you can see. More is a slider nobody wants. */
const BORDER_WIDTHS = [0, 1, 2, 4] as const;
/** The drawn equivalents of the three border styles. `double` is two strokes
 *  rather than a dash pattern, so it is handled where the outline is drawn. */
const OUTLINE_DASH: Record<string, string | undefined> = {
  solid: undefined,
  dashed: "7 5",
  double: undefined,
};

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
interface CanvasNote extends Rect, TalariaInk {
  id: string; // "n:<uuid>"
  text: string;
  color?: string | null;
  /** A sticky can wear an outline too — see `SHAPES`. */
  shape?: string | null;
  /**
   * A picture, before it belongs to anything.
   *
   * Held as a data URI on the collection, which is the one place there is: an
   * attachment needs a block to hang off, and the point of an ephemeral note is
   * that no block exists yet. Converting uploads it properly and this goes
   * away.
   *
   * That is a real cost and the reason for the size cap where these are made. A
   * canvas file is something a person can open and read, and a megabyte of
   * base64 on one line is technically readable and never read again — the same
   * argument Talaria's canvas made for keeping its pictures beside the document
   * rather than in it. Here the bytes are passing through rather than living,
   * so the trade is worth making once and undoing at conversion.
   */
  image?: { name: string; mime: string; data: string } | null;
}
/*
 * ---------------------------------------------------------------------------
 * Talaria's additions, and they are additions rather than changes.
 *
 * The Mac's canvas lets a node say where its words sit across the box and down
 * it, and what color the ink is — `CanvasStyle.swift` is largely the inspector
 * for exactly those three. Hermes' canvas has no such concept: text is left
 * aligned, top set, and the theme's color. Everything else about a node the two
 * already agree on, because the Mac was built against this component's own CSS
 * variables — its comments name `--cv-fill` and `--shadow-soft`.
 *
 * Declared here, applied in `nodeBox`, and kept to those three so the fork
 * stays mergeable.
 * ---------------------------------------------------------------------------
 */
interface TalariaInk {
  /**
   * The picture this node is wearing, ready to draw.
   *
   * A URL for a placed block — `document.ts` builds it with `pictureAt` on the
   * way through the seam — and Hermes' own `{name, mime, data}` for a note,
   * which is what the component makes when one is pasted. `nodeBox` handles
   * both and says so.
   *
   * It was never declared, and `vite build` does not typecheck, so nothing
   * noticed that `ctxOf` was not carrying it: a placed block set to show its
   * photograph showed it until the page was reloaded and then showed a card.
   */
  image?: string | { name: string; mime: string; data: string } | null;
  /** Every picture this node has, by name. Talaria's; Hermes has one or none. */
  images?: string[];
  /** Which of them is its face — the name, where `image` is the URL to draw. */
  imageName?: string | null;
  /** Across the box: `leading` | `center` | `trailing`. The Mac's `TextAlign`. */
  hAlign?: string | null;
  /** And down it: `top` | `middle` | `bottom`. The Mac's `TextVAlign`. */
  vAlign?: string | null;
  /** The ink, when somebody has chosen one. */
  textColor?: string | null;
}

interface CanvasRegion {
  id: string;
  title: string;
  color?: string;
  memberIds: string[];
  /*
   * **No collection behind it.** Hermes' canvas can turn a region into a
   * collection and keep the two in step; this one cannot, and the difference is
   * the point. Talaria's canvas is `canvas.json` — a document somebody
   * arranged, with Canvas Chat as its only other writer — and it reaches the
   * library through the interchange and nowhere else. Creating collections and
   * mirroring membership into them is a second write path into Hermes, hidden
   * inside a drag.
   *
   * It also never worked: `POST /collections` is not a route Talaria's router
   * answers, so the button threw every time it was pressed.
   */
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
  return sideToward(a, { x: b.x + b.w / 2, y: b.y + b.h / 2 });
}

/**
 * Which side of a box faces a point.
 *
 * Scaled by the box's own width and height rather than compared raw, which is
 * what keeps a wide, short card from leaving by its north edge for anything
 * even slightly above it: the question is which side the point is *nearest in
 * proportion*, not which axis the difference is bigger on.
 */
function sideToward(a: Rect, p: { x: number; y: number }): Side {
  const dx = p.x - (a.x + a.w / 2);
  const dy = p.y - (a.y + a.h / 2);
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
  /*
   * Whether the desktop shows through — the Mac's `seeThrough`, and its reason:
   * "off is for when the canvas is the work and the desktop is a distraction."
   *
   * Remembered per machine like the grid. A canvas is a place somebody settles
   * into, and having to turn the blur off again every time it opens is the sort
   * of small tax that makes a surface feel borrowed.
   */
  const [seeThrough, setSeeThrough] = useState(true);
  useEffect(() => {
    document.documentElement.classList.toggle("solid", !seeThrough);
  }, [seeThrough]);

  /*
   * On the desk, frosting is the desk's business.
   *
   * It is one setting across three surfaces — the Mac keeps it in `DeskChrome`
   * for exactly that reason — so the switch lives in the chrome every surface
   * shares and this listens. A canvas opened on its own still has its own
   * button, because then there is no desk to ask.
   */
  useEffect(() => {
    if (window.parent === window) return;
    const heard = (e: MessageEvent) => {
      if (e.data?.talaria !== "frost") return;
      setSeeThrough(Boolean(e.data.on));
    };
    addEventListener("message", heard);
    /*
     * And it asks, rather than waiting to be told.
     *
     * The desk announces the setting when it loads and again when a frame
     * loads, and both of those can happen before this listener exists — on a
     * reload the frame's `load` had already fired by the time the desk's module
     * ran, so the canvas came back see-through on a desk that was not. A
     * question from this side cannot be early.
     */
    window.parent.postMessage({ talaria: "frost?" }, "*");
    return () => removeEventListener("message", heard);
  }, []);

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
  /*
   * The node whose words are open for editing, and only that one.
   *
   * The Mac's rule, in `CanvasSurface.swift`: a click selects, a double-click
   * begins editing, and a drag moves. Here the body of every node was a live
   * text field, so a press put a caret in it and a drag selected text — which
   * left a 16-pixel grip at the top as the only way to move a node, with the
   * four connect dots sitting on the edges either side of it. Trying to drag a
   * node into a region was a coin toss between selecting its text and drawing a
   * connection out of it.
   *
   * The field is made inert (`pointer-events: none`, in `canvas.css`) until the
   * node is this one, which is what lets a press anywhere on the paper be a
   * drag. Scoped to the writing: a linked node's status box is not text and
   * stays clickable, which is the one interaction those are allowed.
   */
  const [editingNode, setEditingNode] = useState<string | null>(null);
  const [wrapH, setWrapH] = useState<number | null>(null);
  useEffect(() => {
    const measure = () => {
      const el = wrapRef.current;
      if (!el) return;
      /*
       * Down to the bottom of the window. Measured rather than guessed at,
       * because what sits above a canvas varies: a banner, a title, a toolbar,
       * none of them.
       *
       * The hair off the end is for a window whose own edge is the canvas's:
       * without it the rounded corners are cut off flush against the bottom of
       * the screen. On the desk that hair is one margin too many — the surface
       * already holds the canvas in 22 pixels of padding on all four sides, so
       * subtracting again gave the bottom 34 and the other three 22, which is
       * exactly the uneven gap it looks like.
       */
      const hair = document.documentElement.classList.contains("framed") ? 0 : 12;
      setWrapH(Math.max(460, window.innerHeight - el.getBoundingClientRect().top - hair));
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
          /*
           * The picture and the ink, which this used to drop on the floor.
           *
           * `document.ts` puts all of these in a member's context on the way in
           * — the URL, the names, which one is worn, the alignment, the text
           * colour — and this rebuilt the context from that one without them.
           * They survived being *set*, because setting spreads over the old
           * object; they did not survive a reload, which is where the member
           * list is read again. A node shown as a photograph came back as a
           * card, and centred text came back left.
           */
          image: c.image ?? null,
          images: c.images,
          imageName: c.imageName ?? null,
          showImage: c.showImage === true,
          hAlign: c.hAlign ?? null,
          vAlign: c.vAlign ?? null,
          textColor: c.textColor ?? null,
          stroke: c.stroke ?? null,
          strokeWidth: typeof c.strokeWidth === "number" ? c.strokeWidth : null,
          strokeStyle: c.strokeStyle ?? null,
        }
      : null;
  };
  // Local position overrides (during + after drags) layered over member context.
  const [local, setLocal] = useState<Record<string, NodeCtx>>({});
  const [notes, setNotes] = useState<CanvasNote[]>(() =>
    Array.isArray(props.canvas_notes)
      ? // Backfill a color on any note lacking one (e.g. an older AI-created
        // note) so it renders as a solid sticky, never transparent.
        /*
         * No default color here, which is the Mac's rule rather than Hermes'.
         *
         * Hermes makes every ephemeral note a sticky — `NOTE_COLOR` — because
         * on that canvas a note *is* a sticky. On this one a node's look comes
         * from its shape: a post-it is paper, everything else is a line round
         * the outside with the canvas showing through. Defaulting here painted
         * a cream rectangle behind text that was supposed to have nothing
         * behind it, before `paperFill` ever saw the node.
         */
        (props.canvas_notes as CanvasNote[]).map((n) => ({ ...n }))
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
  /**
   * Regions with dead members dropped, and regions left holding nothing dropped
   * in turn.
   *
   * In turn, because a region can hold a region: emptying an inner one can empty
   * the outer one that held only it, and that can go on. One pass would leave
   * the outer box naming something that is no longer in the file.
   *
   * Only *region* members are judged. A member id that was never a region is a
   * node, and this is not the place that knows which nodes exist — that is
   * `updateRegionMembership`, which is about where things are rather than
   * whether they are.
   */
  const pruneRegions = (next: CanvasRegion[]): CanvasRegion[] => {
    const known = new Set([...regions, ...next].map((r) => r.id));
    let kept = next;
    for (;;) {
      const alive = new Set(kept.map((r) => r.id));
      const trimmed = kept
        .map((r) => ({
          ...r,
          memberIds: r.memberIds.filter((m) => m !== r.id && (!known.has(m) || alive.has(m))),
        }))
        .filter((r) => r.memberIds.length > 0);
      if (trimmed.length === kept.length) return trimmed;
      kept = trimmed;
    }
  };

  const saveRegions = (next: CanvasRegion[]) => {
    const kept = pruneRegions(next);
    setRegions(kept);
    persistProps({ canvas_regions: kept });
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

  const rectOf = (id: string, seen: Set<string> = new Set()): Rect | null => {
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
    return rg ? regionRect(rg, seen) : null;
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
  /*
   * ---------------------------------------------------------------------------
   * Drop-to-connect, which is how the Mac makes a line.
   *
   * Hermes connects by dragging out of one of four side handles. The Mac drags
   * the node itself onto another and lets go — and reverses the same way, which
   * is the half that matters: "Dropping A on B when they were joined used to
   * re-point the same line at itself — a drag that travelled, landed, and
   * changed nothing visible, which is indistinguishable from a drag that missed.
   * The way to undo a connection was to find it, click it, and press its delete
   * button; the way to make one was a gesture. Undoing something should not be
   * harder to reach than doing it."
   *
   * The handles stay. They are a second way to do it, they are what the mobile
   * layout has, and nothing about them fights this.
   * ---------------------------------------------------------------------------
   */
  /*
   * The target lives in a ref; the state beside it exists only to redraw.
   *
   * The release handler reads this, and a value held in state would be the one
   * from the last render rather than from the last pointer move — a pointerup
   * that arrives before React has committed the move's update would find the
   * previous target, or none. The ref is the answer; the state is the picture.
   */
  const linkTargetRef = useRef<string | null>(null);
  const [linkTarget, showLinkTarget] = useState<string | null>(null);
  const aimAt = (id: string | null) => {
    linkTargetRef.current = id;
    showLinkTarget((was) => (was === id ? was : id));
  };
  /** Whether "into the region" was asked for, sampled while dragging. */
  /*
   * Whether this drag means "connect" rather than "put inside".
   *
   * Ctrl alone, and not Meta. On this desktop Meta belongs to the compositor —
   * Meta+drag is how KWin moves a window, so the key never reaches the page and
   * a gesture built on it is a gesture that does not exist here. The Mac reads
   * ⌘ for the same idea and is welcome to; this is the Linux shell.
   */
  /*
   * A region in add-mode: clicking things puts them in or takes them out.
   *
   * The Mac's `addingTo`, and its reasoning, which is the part worth copying:
   * a drop-to-join is faster once you know about it, and this is "how they find
   * out there is anything to know". It is also the only way to take one thing
   * *out* of a region without deleting it — dragging a member out means hauling
   * it past the region's whole outline, which is a different intent.
   */
  const [addingTo, setAddingTo] = useState<string | null>(null);

  const joining = useRef(false);

  /**
   * What a node let go here would land on.
   *
   * An item before a region, because "a region is mostly the things it holds,
   * and dropping on one of those means that one, not the box around it" — and
   * never a region that already holds what is being dragged, which would be a
   * line from a thing to itself drawn the long way round.
   *
   * Found by hit-testing the DOM rather than by arithmetic: every node carries
   * its id, the topmost one wins by construction, and pointer capture makes
   * hover events unreliable for the rest of a drag — the same reason
   * `finishLink` reads `elementFromPoint`.
   */
  const dropTargetAt = (clientX: number, clientY: number, moving: string): string | null => {
    // Every depth of it: a region can hold a region, and the inner one's cards
    // travel under the pointer just as the outer one's do.
    const carried = regions.some((rg) => rg.id === moving)
      ? new Set<string>([...leavesOf(moving), ...nestedIn(moving)])
      : new Set<string>();
    const stack = document.elementsFromPoint(clientX, clientY) as HTMLElement[];
    for (const el of stack) {
      const node = el.closest<HTMLElement>("[data-block-id]");
      const id = node?.dataset.blockId;
      if (!id || id === moving || carried.has(id)) continue;
      if (regions.some((rg) => rg.id === id) && holds(moving, id)) continue;
      return id;
    }
    return null;
  };

  /**
   * Join two things, or take the join off. The Mac's `link(from:to:)`.
   *
   * A toggle, and direction-blind: a line already there in either direction is
   * the same line. This is the drop gesture's own verb — dragging out of a
   * handle keeps Hermes' behavior, where landing on a pair that is already
   * joined opens that line's settings, because there the gesture said "this
   * line" rather than "these two".
   */
  /** Put a node back where a drag started. Notes and blocks are moved the same
   *  way everywhere else in this file; this is that, in one place. */
  const moveTo = (id: string, at: { x: number; y: number }) => {
    if (id.startsWith("n:")) {
      setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, x: at.x, y: at.y } : n)));
      return;
    }
    setLocal((prev) => {
      const was = prev[id] ?? rectOf(id);
      return was ? { ...prev, [id]: { ...(was as NodeCtx), x: at.x, y: at.y } } : prev;
    });
  };

  /** Into the box rather than onto it — the held-down drop. The region grows by
   *  itself, because it is the extent of what it holds. */
  /** In add-mode, a click on a thing means in-or-out rather than select. */
  const toggleMembership = (regionId: string, nodeId: string) => {
    const rg = regions.find((r) => r.id === regionId);
    if (!rg || rg.id === nodeId) return;
    if (!rg.memberIds.includes(nodeId)) {
      if (wouldNest(nodeId, regionId)) {
        showToast("That box is already outside this one.");
        return;
      }
      return joinRegion(regionId, nodeId);
    }
    // Refusing silently is indistinguishable from a click that did not
    // register — the Mac says the same thing in the same situation.
    if (rg.memberIds.length <= 1) {
      showToast("A region has to hold something — delete the region instead.");
      return;
    }
    saveRegions(regions.map((r) => (
      r.id === regionId ? { ...r, memberIds: r.memberIds.filter((m) => m !== nodeId) } : r
    )));
  };

  const joinRegion = (regionId: string, nodeId: string) => {
    // A member may be another region — boxes nest — but not one this box is
    // already inside. See `wouldNest`.
    if (wouldNest(nodeId, regionId)) return;
    const next = regions.map((rg) =>
      rg.id === regionId && !rg.memberIds.includes(nodeId)
        ? { ...rg, memberIds: [...rg.memberIds, nodeId] }
        : rg,
    );
    saveRegions(next);
    if (nodeId.startsWith("n:")) persistProps({ canvas_notes: notes });
    else if (!regions.some((rg) => rg.id === nodeId)) {
      // A region has no geometry of its own to write down — its box is the
      // extent of what it holds — and no collection member to write it to.
      const r = rectOf(nodeId);
      if (r) persistMemberCtx(nodeId, r as NodeCtx);
    }
  };

  const toggleLink = (from: string, to: string) => {
    if (from === to) return;
    const existing = edges.find(
      (e) => (e.from === from && e.to === to) || (e.from === to && e.to === from),
    );
    if (existing) {
      saveEdges(edges.filter((e) => e.id !== existing.id));
      return;
    }
    const fr = rectOf(from);
    const tr = rectOf(to);
    if (!fr || !tr) return;
    // Meet on the sides that face each other.
    const dx = fr.x + fr.w / 2 - (tr.x + tr.w / 2);
    const dy = fr.y + fr.h / 2 - (tr.y + tr.h / 2);
    const across = Math.abs(dx) / tr.w > Math.abs(dy) / tr.h;
    const toSide: Side = across ? (dx > 0 ? "e" : "w") : dy > 0 ? "s" : "n";
    const fromSide: Side = across ? (dx > 0 ? "w" : "e") : dy > 0 ? "n" : "s";
    saveEdges([
      ...edges,
      {
        id: uid(),
        from,
        to,
        fromSide,
        toSide,
        arrow: "forward",
      },
    ]);
  };


  /*
   * The document can change while this is mounted, which it cannot in Hermes.
   *
   * There, the canvas is the only thing that writes a canvas: state is seeded
   * from props once and every later change is one this component made. Talaria
   * has a second writer — Canvas Chat edits `canvas.json` through the daemon —
   * so a turn that adds three nodes updates the file, the page re-reads it, and
   * without this the component carries on drawing the document it was born
   * with. It looked exactly like the chat lying about what it had done.
   *
   * Compared by content rather than by identity: `main.tsx` hands over a fresh
   * object on every read, including the reads that follow this component's own
   * edits, and adopting on identity would put the caret-time state back a beat
   * on every one of them.
   */
  const adopted = useRef("");
  useEffect(() => {
    const said = JSON.stringify([props.canvas_notes, props.canvas_edges, props.canvas_regions]);
    if (said === adopted.current) return;
    adopted.current = said;
    if (Array.isArray(props.canvas_notes)) setNotes((props.canvas_notes as CanvasNote[]).map((n) => ({ ...n })));
    if (Array.isArray(props.canvas_edges)) {
      setEdges((props.canvas_edges as CanvasEdge[]).map((e) => (e.id ? e : { ...e, id: uid() })));
    }
    if (Array.isArray(props.canvas_regions)) setRegions(props.canvas_regions as CanvasRegion[]);
    // Anything held locally over the top of a member's stored geometry is about
    // the document that has just been replaced.
    setLocal({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.canvas_notes, props.canvas_edges, props.canvas_regions]);

  /*
   * Fit everything into the window — for a picture of the canvas.
   *
   * Only in export mode, and only there because the canvas has no zoom-to-fit
   * of its own: on screen the view is wherever somebody left it, which is
   * correct, and a photograph of "wherever somebody left it" is a photograph
   * with half the drawing outside the frame. The shell sizes its off-screen
   * window to the drawing and this puts the drawing in it.
   *
   * Re-run on resize, because the shell resizes *after* the first layout: it has
   * to ask how big the drawing is before it can make a window that shape.
   */
  const exporting = typeof location !== "undefined" && new URLSearchParams(location.search).has("export");
  useEffect(() => {
    if (!exporting) return;
    const fit = (): { w: number; h: number } | null => {
      const boxes = [
        ...notes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h })),
        ...members.map((m) => local[m.id] ?? ctxOf(m)).filter((r): r is NodeCtx => r !== null),
        ...regions.map((rg) => regionRect(rg)).filter((r): r is Rect => r !== null),
      ];
      /*
       * The lines count too, and they go where the nodes do not.
       *
       * A connection is a curve through a control point pulled off the straight
       * line between its ends, so it can bow a long way outside both of them —
       * and an export framed on the nodes alone cut one off at the edge while
       * every node sat comfortably inside. `.cv-svg` has a viewBox in canvas
       * coordinates, which is what makes this a two-line fix instead of a second
       * implementation of the curve maths: `getBBox` is the exact extent of what
       * was actually drawn, in the same units as everything above.
       */
      for (const drawn of document.querySelectorAll<SVGGraphicsElement>(".cv-svg path")) {
        // **Not the arrowheads.** A marker's path lives in `<defs>` in its own
        // little coordinate system, so its bbox is a 10x10 box at the origin —
        // which dragged the drawing's bounds back to 0,0 and made the export
        // half again as wide as the picture, with the whole thing pushed into
        // the bottom right of it.
        if (drawn.closest("defs")) continue;
        try {
          const b = drawn.getBBox();
          if (b.width || b.height) boxes.push({ x: b.x, y: b.y, w: b.width, h: b.height });
        } catch {
          // Not rendered, so it is not in the picture either.
        }
      }
      if (!boxes.length) return null;
      const minX = Math.min(...boxes.map((b) => b.x));
      const minY = Math.min(...boxes.map((b) => b.y));
      const maxX = Math.max(...boxes.map((b) => b.x + b.w));
      const maxY = Math.max(...boxes.map((b) => b.y + b.h));
      const pad = 40;
      const w = maxX - minX + pad * 2;
      const h = maxY - minY + pad * 2;
      const z = Math.min(1, Math.min(innerWidth / w, innerHeight / h));
      setView({
        z,
        x: (innerWidth - w * z) / 2 - (minX - pad) * z,
        y: (innerHeight - h * z) / 2 - (minY - pad) * z,
      });
      // The padded extent of the drawing, in document units — the size the
      // window wants to be. Said from here because this is the one place that
      // knows it without the current zoom in the way: measuring the rendered
      // page instead answers in screen pixels at whatever scale it is currently
      // showing, which is smaller than the truth exactly when it matters.
      return { w: Math.ceil(w), h: Math.ceil(h) };
    };
    fit();
    /*
     * And the shell can ask, rather than the resize event being trusted.
     *
     * The window is resized *after* the drawing has been measured — it has to
     * be, since the size of the window is the answer — and on Wayland the
     * `resize` event that should re-fit it did not arrive before the picture was
     * taken. So the export came out correctly sized and wrongly framed: laid out
     * for 1400x900, photographed at 1096x725, with the right-hand side of the
     * drawing outside the frame. The shell calls this and then shoots.
     */
    (window as unknown as { __exportFit: () => { w: number; h: number } | null }).__exportFit = fit;
    addEventListener("resize", fit);
    return () => removeEventListener("resize", fit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exporting, notes, members, regions]);

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
    /*
     * The even-gap rule the Mac calls `spacingOffer` is **not here**, and that
     * is deliberate: `evenSpacing` above already does it, and does more. The
     * Mac continues a run's gap at either end; that one also centers a box
     * between two neighbors, prefers the gap the row uses most so a single odd
     * spacing cannot set the rhythm, and draws the measurements. It is applied
     * where the axis is still free, after this — which is the same order the
     * Mac uses, alignment first and the grid last.
     *
     * A port was written here before that was read, and it fired first and
     * suppressed the better rule.
     */
    // The grid only where nothing else claimed the axis, which is what "loses
    // every tie" means in practice: `bx` is still the tolerance when nothing
    // matched.
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
   * The dot grid, drawn at 24px — the Mac's step — and snapped to at the same
   * spacing, so a node lands on a dot rather than near one.
   *
   * Offered last everywhere it is offered, and losing every tie, so a box
   * already touching a neighbour's edge is not pulled off it by a grid line the
   * same distance away. Alignment to another card is a thing somebody meant;
   * the grid is a thing they get.
   *
   * Only when the grid is showing. Snapping to lines nobody can see is a canvas
   * that moves in steps for no visible reason.
   */
  /*
   * Twenty-four, which is the Mac's — `chrome.grid ? 24 : nil`, and its own
   * grid is drawn at `24 * zoom`. Hermes draws and snaps to twenty-six. Two
   * pixels sounds like nothing and is not: the same canvas opened on the two
   * machines puts every snapped node on a different coordinate, and they drift
   * further apart the further right you go.
   */
  const GRID = 24;
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
  const rectFromIds = (ids: string[], seen: Set<string> = new Set()): Rect | null => {
    const rs = ids.map((id) => rectOf(id, seen)).filter((r): r is Rect => r !== null);
    if (!rs.length) return null;
    const x1 = Math.min(...rs.map((r) => r.x));
    const y1 = Math.min(...rs.map((r) => r.y));
    const x2 = Math.max(...rs.map((r) => r.x + r.w));
    const y2 = Math.max(...rs.map((r) => r.y + r.h));
    return { x: x1 - REGION_PAD, y: y1 - REGION_TOP, w: x2 - x1 + REGION_PAD * 2, h: y2 - y1 + REGION_TOP + REGION_PAD };
  };
  /*
   * A region's box, which may be worked out through other regions' boxes:
   * regions nest, and `rectOf` answers for a region id as readily as for a
   * node's.
   *
   * `seen` is the stop. A loop cannot be made through the UI — `wouldNest`
   * refuses it — but a `canvas.json` can arrive with one, and the recursion
   * that draws the canvas must not be the thing that finds out.
   */
  const regionRect = (rg: CanvasRegion, seen: Set<string> = new Set()): Rect | null =>
    seen.has(rg.id) ? null : rectFromIds(rg.memberIds, new Set(seen).add(rg.id));

  /** Every node a region holds, however deep — its nested regions resolved away.
   *  A Set, because two nested boxes may hold the same card and moving it once
   *  per box would move it twice as far as the pointer went. */
  const leavesOf = (regionId: string): string[] => {
    const found = new Set<string>();
    const seen = new Set<string>();
    const stack = [regionId];
    for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
      if (seen.has(next)) continue;
      seen.add(next);
      const rg = regions.find((r) => r.id === next);
      if (rg) stack.push(...rg.memberIds);
      else found.add(next);
    }
    return [...found];
  };

  /**
   * Whether a region holds this at any depth.
   *
   * Not the same question as `memberIds.includes`, and the difference is a bug
   * that only appears once regions nest: a card in an inner box is *inside* the
   * outer box too, but is not one of its members. The drop target has to mean
   * this one, or moving a card about inside its own group draws a line from the
   * card to the group.
   */
  const holds = (id: string, regionId: string): boolean => {
    const seen = new Set<string>();
    const stack = [regionId];
    for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
      if (seen.has(next)) continue;
      seen.add(next);
      const rg = regions.find((r) => r.id === next);
      if (!rg) continue;
      if (rg.memberIds.includes(id)) return true;
      stack.push(...rg.memberIds);
    }
    return false;
  };

  /** The regions a region holds, however deep. Its own id is not in it. */
  const nestedIn = (regionId: string): Set<string> => {
    const found = new Set<string>();
    const seen = new Set<string>();
    const stack = [regionId];
    for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
      if (seen.has(next)) continue;
      seen.add(next);
      const rg = regions.find((r) => r.id === next);
      if (!rg) continue;
      if (next !== regionId) found.add(next);
      stack.push(...rg.memberIds);
    }
    return found;
  };

  /**
   * Whether putting `member` inside `region` would make a box that contains
   * itself.
   *
   * Asked before the join rather than coped with afterwards: a loop has no
   * extent, so both boxes would simply stop being drawn — the region would look
   * deleted, by a gesture that said "put this in here".
   */
  const wouldNest = (member: string, region: string): boolean =>
    member === region || nestedIn(member).has(region);
  const inRect = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

  /**
   * After a node drag: joins the region it landed in. Nothing ever leaves.
   *
   * There used to be a boundary — a member had to be hauled past its region's
   * pre-drag outline plus ninety pixels of grace before it was dropped from it,
   * with the grace there to stop an ordinary nudge ejecting something. It is
   * gone, and the reason is that membership now has a way to be *said*: the `+`
   * on a region turns on add-mode and a click takes a thing out. A gesture that
   * removes something as a side effect of moving it is guesswork wearing a
   * threshold, and no threshold makes "I was rearranging" and "I meant to take
   * this out of the box" the same shape.
   *
   * So a member dragged anywhere stays a member, and the region reshapes around
   * it — which it does by itself, a region being the extent of what it holds.
   */
  const updateRegionMembership = (nodeId: string) => {
    const r = rectOf(nodeId);
    if (!r) return;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    let changed = false;
    const next = regions
      .map((rg) => {
        if (rg.memberIds.includes(nodeId)) return rg;
        // Joining uses the strict current outline — dropping INTO a region
        // should feel precise, not magnetic.
        const base = rectFromIds(rg.memberIds.filter((id) => id !== nodeId));
        if (base && inRect(base, cx, cy)) {
          changed = true;
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
    | {
        kind: "node";
        id: string;
        dx: number;
        dy: number;
        moved: boolean;
        /** Where it started, for a drop that connects instead of moving. */
        from: { x: number; y: number };
      }
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

      /*
       * A sideways swipe belongs to the desk, not to the canvas.
       *
       * On the desk this canvas is one surface of several and a two-finger
       * swipe is how you leave it. Panning with that gesture makes the canvas a
       * room with no door: the swipe is consumed here, the desk never sees it —
       * a frame's wheel events do not cross the boundary — and the only way out
       * is the pointer.
       *
       * So the gesture is handed back, by the only route there is. The test is
       * the Mac's: decisively sideways rather than merely more sideways than
       * not, so a diagonal on the way to scrolling something still pans. Nothing
       * is prevented, and nothing pans, which is what makes it *given up*
       * rather than copied.
       *
       * The canvas still pans in every other way — dragging empty space, the
       * arrow keys, a vertical swipe, and sideways with a modifier held.
       */
      const sideways = Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.6 && Math.abs(e.deltaX) > 1;
      if (sideways && !e.shiftKey && window.parent !== window) {
        // Prevented *and* forwarded. Without the prevent the browser may also
        // chain the unconsumed scroll to the page holding this frame, which
        // would count the same swipe twice and turn one page turn into two.
        e.preventDefault();
        window.parent.postMessage({ talaria: "swipe", dx: e.deltaX, dy: e.deltaY }, "*");
        return;
      }

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
    // A press on bare canvas puts the open field away, which is what makes the
    // next press on that node a drag rather than a caret — and ends add-mode,
    // which is the same gesture meaning "done with that box".
    setEditingNode(null);
    setAddingTo(null);
    /*
     * Shift, or the Select tool.
     *
     * Hermes marquees on shift-drag and pans otherwise, which is right for a
     * mouse and awkward on a trackpad, where the hand is already doing two
     * things. The Mac has a tool you arm instead — a mode, on until you turn it
     * off — and this is that tool asking: the strip sets the flag on the root
     * because it is a sibling of this component and not its parent.
     */
    const arming = document.documentElement.dataset.select === "on";
    if ((e.shiftKey || arming) && !locked) {
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
    // The nodes, not the members: a member may be another region, which has no
    // geometry of its own to move. Resolving to leaves is also what keeps a card
    // held by both an inner and an outer box from traveling twice as far as the
    // pointer.
    const starts: Record<string, Rect> = {};
    for (const mid of leavesOf(rg.id)) {
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
    /*
     * **No relation filing, and no live edges.**
     *
     * Hermes files a connection between two blocks under a reference field when
     * their types have one, so the line *is* the relation. Talaria cannot: a
     * relation is a fact about two blocks in the library, and writing one means
     * writing to Hermes — which happens through the interchange or not at all,
     * and `canvas.json` is not the interchange. Its lines are canvas decoration,
     * and they say so by being nothing else.
     */
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
      if (e.key === "Escape") { setLinking(null); setAddingTo(null); }
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
      /*
       * Three pixels before it counts as a drag — the Mac's threshold, and it
       * matters more here than it did there. A press that travels one pixel
       * used to be a move nobody could see; now a move that ends over another
       * node connects them, so the difference between a click and a drag is the
       * difference between selecting a card and rearranging the diagram.
       */
      if (!d.moved) {
        const travel = Math.hypot((p.x - d.dx - d.from.x) * view.z, (p.y - d.dy - d.from.y) * view.z);
        if (travel <= 3) return;
      }
      d.moved = true;
      // What letting go now would join this to — read every move, because that
      // is what makes the highlight follow the pointer.
      aimAt(dropTargetAt(e.clientX, e.clientY, d.id));
      // Sampled here rather than read on release: a pointerup does not always
      // carry the modifier that was down a moment before it.
      joining.current = e.ctrlKey;
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
      // A region can be dropped on something too, and the target-finder already
      // knows to skip whatever it is carrying: "its members travel under the
      // pointer for the whole drag, so without this the likeliest outcome of
      // moving a region is a line from the box to something already inside it."
      if (d.kind === "region") {
        aimAt(dropTargetAt(e.clientX, e.clientY, d.id));
        // Sampled every move, like a node's: a pointerup does not always carry
        // the modifier that was down a moment before it.
        joining.current = e.ctrlKey;
      }
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
    holding(false);
    const d = drag.current;
    drag.current = null;
    setGuides([]);
    setSpacings([]);
    // Read before it is cleared: the branch below acts on it, and clearing it
    // first is how the first version threw the target away a few lines before
    // asking for it.
    const onto = linkTargetRef.current;
    aimAt(null);
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
      if (onto && !joining.current && regions.some((rg) => rg.id === onto) && !wouldNest(d.id, onto)) {
        /*
         * A region dropped on a region goes inside it — the same trade a node
         * makes, and the reason regions nest at all. The box stays where it was
         * let go, because the outer box is the extent of what it holds and has
         * already grown to fit. Hold the modifier to draw a line between them
         * instead.
         */
        joinRegion(onto, d.id);
        persistProps({ canvas_notes: notes });
        for (const mid of leavesOf(d.id)) {
          if (mid.startsWith("n:")) continue;
          const r = rectOf(mid);
          if (r) persistMemberCtx(mid, r as NodeCtx);
        }
        setSelected([]);
        return;
      }
      if (onto) {
        // Dropped on something: the box and everything it carries go back, and
        // a line is what is left behind — the same trade a node makes.
        for (const [mid, start] of Object.entries(d.starts)) moveTo(mid, start);
        toggleLink(d.id, onto);
        setSelected([]);
        return;
      }
      const rg = regions.find((r) => r.id === d.id);
      if (rg) {
        persistProps({ canvas_notes: notes });
        for (const mid of leavesOf(rg.id)) {
          if (mid.startsWith("n:")) continue;
          const r = rectOf(mid);
          if (r) persistMemberCtx(mid, r as NodeCtx);
        }
      }
      return;
    }
    if (d.kind === "node" && d.moved) {
      if (onto) {
        /*
         * Dropped on something. Onto a node that means a connection; onto a
         * region it means *into* the region.
         *
         * It was the other way round — plain connected, and the modifier put it
         * in — which is the Mac's ⌘ trade, and it made the ordinary thing
         * impossible to find. Dragging a card into a box is the gesture
         * everybody tries first, and it drew a line to the box and put the card
         * back; there was nothing on screen to suggest a key. A region has its
         * own connect handles for the rarer intent, and the modifier still
         * reaches it.
         *
         * A node is different and keeps its old meaning: two cards on a canvas
         * are things you relate far more often than things you nest.
         */
        const ontoRegion = regions.some((rg) => rg.id === onto);
        const intoRegion = ontoRegion && !joining.current;
        if (intoRegion) {
          joinRegion(onto, d.id);
        } else {
          moveTo(d.id, d.from);
          toggleLink(d.id, onto);
          setSelected([]);
        }
        joining.current = false;
        return;
      }
      const r = rectOf(d.id);
      if (!r) return;
      if (d.id.startsWith("n:")) persistProps({ canvas_notes: notes });
      else persistMemberCtx(d.id, r as NodeCtx);
      updateRegionMembership(d.id);
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
    holding(true);
  };

  /*
   * The hand stays closed for the length of the drag.
   *
   * A cursor set on the node is only the cursor while the pointer is over the
   * node, and a drag is precisely the gesture that takes it somewhere else —
   * so it turned back into an arrow the moment the node started moving, which
   * reads as the drag having been dropped. `:active` does not cover it either:
   * with the pointer captured, the pointer is not over the element any more.
   *
   * A class on the surface does, because the surface is what the pointer is
   * over for the whole gesture. Set on the element rather than through state:
   * a drag deliberately avoids re-rendering, which is why `drag` is a ref.
   */
  const holding = (on: boolean) =>
    wrapRef.current?.classList.toggle("cv-holding", on);

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
    // Where it came from. A drop that connects puts the node back: "the gesture
    // said 'this one goes with that one', not 'this one goes here', so the box
    // goes back where it came from and a line is what is left behind. Leaving it
    // where it landed would mean every connection also rearranged the diagram."
    drag.current = {
      kind: "node", id, dx: p.x - r.x, dy: p.y - r.y, moved: false,
      from: { x: r.x, y: r.y },
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    holding(true);
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

  /**
   * Another picture on a node that already has one.
   *
   * The chooser and the daemon's sweep have both understood several pictures per
   * node from the start — `image` is which one is showing, `images` is what there
   * is — but nothing made the second one. Loading a saved canvas could, and
   * converting a note could; a person could not.
   *
   * The file goes the same way every other picture does: resized, kept beside the
   * document, named on the item. Adding one does not change which is showing —
   * that is what the chooser is for, and a node that swapped its face because you
   * added an alternative would be answering a question nobody asked.
   */
  const addPictureTo = (id: string) => {
    const pick = document.createElement("input");
    pick.type = "file";
    pick.accept = "image/*";
    pick.onchange = async () => {
      const file = pick.files?.[0];
      if (!file) return;
      let kept: { name: string; w: number; h: number };
      try {
        kept = await keepResized(file);
      } catch (err) {
        window.alert(String((err as Error).message || err));
        return;
      }
      if (id.startsWith("n:")) {
        saveNotes(
          notes.map((n) =>
            n.id === id ? { ...n, images: [...(n.images ?? (n.imageName ? [n.imageName] : [])), kept.name] } : n,
          ),
        );
        return;
      }
      const r = rectOf(id) as NodeCtx | null;
      if (!r) return;
      const ctx = { ...r, images: [...(r.images ?? (r.imageName ? [r.imageName] : [])), kept.name] };
      setLocal((p) => ({ ...p, [id]: ctx }));
      persistMemberCtx(id, ctx);
    };
    pick.click();
  };

  /** Which of a node's pictures is the one you see. */
  const choosePicture = (id: string, name: string) => {
    const r = rectOf(id) as NodeCtx | null;
    if (!r) return;
    const ctx = { ...r, imageName: name, image: pictureAt(name), showImage: true };
    setLocal((p) => ({ ...p, [id]: ctx }));
    if (id.startsWith("n:")) {
      saveNotes(notes.map((n) => (n.id === id ? { ...n, imageName: name, image: { name, mime: "", data: pictureAt(name) } } : n)));
      return;
    }
    persistMemberCtx(id, ctx);
  };

  const setShowImage = (id: string, showImage: boolean) => {
    const r = rectOf(id) as NodeCtx | null;
    if (!r) return;
    const ctx = { ...r, showImage };
    setLocal((p) => ({ ...p, [id]: ctx }));
    persistMemberCtx(id, ctx);
  };

  /*
   * The three border keys, and only those.
   *
   * It took a `Partial<NodeCtx>`, which let it spread any node field onto a
   * note — and once `image` was declared honestly (a URL for a member, an object
   * for a note) the compiler could see that a patch typed that wide could widen
   * a note's picture into something a note cannot hold. Every caller passes
   * border keys; the signature says so now.
   */
  const setBorder = (
    id: string,
    patch: Pick<Partial<NodeCtx>, "stroke" | "strokeWidth" | "strokeStyle">,
  ) => {
    if (id.startsWith("n:")) {
      saveNotes(notes.map((n) => (n.id === id ? { ...n, ...patch } : n)));
      return;
    }
    const r = rectOf(id) as NodeCtx | null;
    if (!r) return;
    const ctx = { ...r, ...patch };
    setLocal((p) => ({ ...p, [id]: ctx }));
    persistMemberCtx(id, ctx);
  };

  /**
   * The border a node is actually drawn with.
   *
   * Nothing set is not the same as zero: a node nobody has touched wears the
   * theme's hairline, and a node set to zero wears none. Returning undefined
   * for the first lets the stylesheet keep its say.
   */
  const borderOf = (r: NodeCtx): string | undefined => {
    const hasAny = r.stroke != null || r.strokeWidth != null || r.strokeStyle != null;
    if (!hasAny) return undefined;
    const w = r.strokeWidth ?? 1;
    if (w === 0) return "none";
    return `${w}px ${r.strokeStyle ?? "solid"} ${r.stroke ?? "var(--border-strong)"}`;
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

  /** Bigger than a sticky, because a picture in a sticky is a thumbnail. */
  const IMAGE_W = 260;
  const IMAGE_H = 200;
  /**
   * How large a picture may be before conversion.
   *
   * It rides on the collection until then, so this is a limit on how much of
   * somebody's canvas file is base64 rather than canvas. Generous enough for a
   * screenshot and a photograph, and short of the point where the document
   * stops being one anybody can open.
   */
  const IMAGE_CAP = 4 * 1024 * 1024;

  /**
   * A picture, pasted or dropped.
   *
   * Hermes reads the file into a data URI and hangs it on the collection, with
   * its own comment calling that a cost it pays until conversion: "a canvas file
   * is something a person can open and read, and a megabyte of base64 on one
   * line is technically readable and never read again — the same argument
   * Talaria's canvas made for keeping its pictures beside the document rather
   * than in it."
   *
   * Here it is kept beside the document from the start, by the same route the
   * tool strip uses. Anything else would produce a note whose picture is visible
   * until the page is read again and points at a file that never existed.
   */
  const addImageNote = async (file: File, at?: { x: number; y: number }) => {
    if (!file.type.startsWith("image/")) return;
    let kept: { name: string; w: number; h: number };
    try {
      kept = await keepResized(file);
    } catch (err) {
      window.alert(String((err as Error).message || err));
      return;
    }
    const c = at ?? viewCenter();
    const spot = at
      ? { x: at.x - kept.w / 2, y: at.y - kept.h / 2 }
      : findSpot(c.x, c.y, kept.w, kept.h, allRects());
    saveNotes([
      ...notes,
      {
        id: `n:${uid()}`,
        x: Math.round(spot.x),
        y: Math.round(spot.y),
        w: kept.w,
        h: kept.h,
        text: "",
        // The name is what the file stores; the object is what this component
        // reads. `imageName` is the one the seam writes down.
        imageName: kept.name,
        image: { name: kept.name, mime: file.type, data: pictureAt(kept.name) },
        images: [kept.name],
        showImage: true,
        // A picture is the node: no paper behind it and no line round it.
        shape: "plain",
        color: null,
      } as CanvasNote,
    ]);
  };

  const convertNote = async (note: CanvasNote, type: BlockType) => {
    // A picture has no words. Its filename is the only thing it brought with
    // it, and a block called "Untitled" tells somebody less than one called
    // "roof-damage.jpg" — which they can rename in the field that is now theirs
    // to fill in.
    const text = note.text.trim() || (note.image ? note.image.name.replace(/\.[^.]+$/, "") : "");
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
    /**
     * The picture becomes a real attachment, now that there is something to
     * attach it to.
     *
     * This is the whole point of converting an image note rather than leaving
     * it: the bytes stop riding on the collection as base64 and become a file
     * on the block, where they can be downloaded, replaced and deleted like any
     * other. The node keeps showing the picture, because that is what it looked
     * like a moment ago and a conversion that changed the drawing as well as
     * the substance would read as having done something else.
     *
     * Awaited before the note is removed, and before the member is placed:
     * failing here must leave the note where it was rather than half-converted
     * with its picture nowhere.
     */
    if (note.image) {
      const blob = await (await fetch(note.image.data)).blob();
      const form = new FormData();
      form.append("file", new File([blob], note.image.name, { type: note.image.mime }));
      await api.upload<Attachment[]>(`/blocks/${b.id}/attachments`, form);
    }
    await api.post(`/collections/${cid}/members`, {
      blockId: b.id,
      context: {
        x: note.x,
        y: note.y,
        w: note.w,
        h: note.h,
        color: note.color ?? null,
        /*
         * The picture comes with it.
         *
         * Hermes turns a note's image into an attachment on the new block and
         * lets the node keep showing it, "because that is what it looked like a
         * moment ago and a conversion that changed the drawing as well as the
         * substance would read as having done something else." Talaria cannot
         * make it an attachment — the format's `attachment` value is a file name
         * and carries no bytes, and Hermes' own manifest declares attachments
         * unsupported — but the second half holds: the picture stays on the
         * canvas, beside the document, and the node goes on showing it.
         */
        ...(note.image ? { showImage: true, image: note.image.name } : {}),
      },
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
          // The block takes the note's place in the region, and that is the
          // whole of it — a region is an arrangement on this canvas and has no
          // collection behind it to tell.
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
    /**
     * Where the line is heading, which is not always the other end.
     *
     * With no bend it is the point halfway between the two centres, so each end
     * leaves by the side facing the other — which is what it has always done.
     * Pull the handle up and over and both ends re-anchor on the way, because
     * the thing they are aiming at has moved.
     *
     * Without this a bent line left by the side it would have left by straight
     * and then doubled back on itself, which reads as the drag fighting you
     * rather than as a curve.
     */
    const aim = {
      x: (fr.x + fr.w / 2 + tr.x + tr.w / 2) / 2 + (e.bendX ?? 0),
      y: (fr.y + fr.h / 2 + tr.y + tr.h / 2) / 2 + (e.bendY ?? 0),
    };
    const fromSide = sideToward(fr, aim);
    const toSide = sideToward(tr, aim);
    const a = anchor(fr, fromSide);
    const b = anchor(tr, toSide);
    /*
     * One curve, through a control point on the line between the anchors.
     *
     * Hermes pushes each control point out along its own side's normal, which
     * makes every connector leave and arrive square-on — a flowchart look, and
     * a good one when a canvas is a diagram of boxes. The Mac does not: its
     * control is "the midpoint of the two *anchors*, plus twice the bend", so a
     * link nobody has bent is a straight line between two points on two edges,
     * and the arrowhead lands at the angle the line actually travelled.
     *
     * That is the difference somebody sees. A node up and to the right used to
     * be met by an arrow pointing straight up, because the curve was bent
     * vertical in its last few pixels to arrive perpendicular to the edge it
     * touched. Now it points up and to the right, at the thing it came from.
     *
     * Twice the bend, and the reason is the same arithmetic Hermes was doing at
     * four thirds for a cubic: a quadratic at its halfway mark sits at
     * `(a + 2c + b) / 4`, so a control at `midpoint + 2·bend` puts the middle of
     * the line at `midpoint + bend` — exactly where the grip was dragged to.
     */
    const bx = e.bendX ?? 0;
    const by = e.bendY ?? 0;
    const control = { x: (a.x + b.x) / 2 + 2 * bx, y: (a.y + b.y) / 2 + 2 * by };
    return {
      d: `M ${a.x} ${a.y} Q ${control.x} ${control.y}, ${b.x} ${b.y}`,
      // The curve's own halfway point, which for this construction is the
      // anchors' midpoint plus the bend — the Mac's `handle`, and the one place
      // the grip can sit without being beside its line.
      mid: { x: (a.x + b.x) / 2 + bx, y: (a.y + b.y) / 2 + by },
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
  /**
   * The edge being bent, as state.
   *
   * The ref above carries the drag's arithmetic and cannot decide what is
   * drawn: changing it re-renders nothing, so a grip whose visibility depended
   * on it was reading a stale answer. This keeps the grip on screen for as long
   * as it is being held.
   */
  const [bending, setBending] = useState<string | null>(null);

  const startBend = (e: CanvasEdge, ev: React.PointerEvent) => {
    if (locked) return;
    ev.preventDefault();
    ev.stopPropagation();
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
    bendDrag.current = { id: e.id, sx: ev.clientX, sy: ev.clientY, bx: e.bendX ?? 0, by: e.bendY ?? 0 };
    setBending(e.id);
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
    /*
     * Straight, and level, and plumb — three snaps rather than one.
     *
     * Hermes pulls a bend back to nothing when the whole offset is small, which
     * catches "I dragged this out and changed my mind". The Mac catches two
     * more, and says why: "a bend that is straight on one axis. Pulling a handle
     * sideways along a horizontal line should be able to stay level." Without
     * them a connector nudged along its own axis ends up a pixel or two off
     * true, which is exactly the drift that makes a diagram look sloppy.
     */
    const tol = 6 / view.z;
    const straight = Math.hypot(nx, ny) <= tol;
    patchEdge(d.id, {
      bendX: straight || Math.abs(nx) <= tol ? 0 : nx,
      bendY: straight || Math.abs(ny) <= tol ? 0 : ny,
    });
  };
  const endBend = () => {
    bendDrag.current = null;
    setBending(null);
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

  /**
   * Where the words sit, as CSS.
   *
   * The paper is already a column flexbox — a grip, then the body — so down the
   * box is `justify-content` on it and across the box is `text-align` on what is
   * written. The Mac's vocabulary is kept verbatim (`leading`/`center`/
   * `trailing`, `top`/`middle`/`bottom`) because it is what is in the file, and
   * a canvas made on one machine is opened on the other.
   */
  /**
   * What is painted behind the words, and usually nothing.
   *
   * The Mac's rule, in its own words: "the rule this canvas started from is that
   * text has no background, and a shape is a line round the outside rather than
   * permission to paint behind the words." So a color somebody chose is paper,
   * a post-it is paper because a post-it *is* paper, and everything else is an
   * outline with the canvas showing through.
   *
   * Hermes differs here and it is not an accident on its side either: an
   * ephemeral note there is a sticky by definition and defaults to one. On this
   * canvas a note's look comes from its shape, which is what `shapeDefaults` in
   * the daemon says too — post-it yellow, everything else nothing.
   */
  const paperFill = (r: NodeCtx): string | undefined => {
    if (r.color) return r.color;
    const shape = r.shape ?? "plain";
    return shape === "postIt" ? "var(--postit)" : "transparent";
  };

  const alignment = (r: NodeCtx): React.CSSProperties => {
    const across = { leading: "left", center: "center", trailing: "right" } as const;
    const down = { top: "flex-start", middle: "center", bottom: "flex-end" } as const;
    const h = r.hAlign && across[r.hAlign as keyof typeof across];
    const v = r.vAlign && down[r.vAlign as keyof typeof down];
    return { ...(h ? { textAlign: h } : {}), ...(v ? { justifyContent: v } : {}) };
  };

  const nodeBox = (id: string, r: NodeCtx, body: ReactNode, isNote: boolean) => {
    // A node told to show its picture asks for one on sight: here it is not a
    // menu item that might be needed, it is the thing being drawn.
    /*
     * The picture a node names, which is not the same as one Hermes holds.
     *
     * Hermes asks the server what is attached to the block and draws the first
     * image it finds. Talaria's pictures live beside the canvas document and the
     * node names one, so there is nothing to ask: `r.image` is the URL the
     * daemon serves it at. A canvas that shows a photograph therefore shows it
     * with the network down, which the other way round could not.
     */
    /*
     * …in whichever of the two shapes it arrives in.
     *
     * A member's picture comes through the seam as a URL; a note's is Hermes'
     * own `{name, mime, data}`, because that is what the component builds when
     * one is pasted and what every other line here reads. Treating both as a
     * URL put `[object Object]` in the `src` — visible only after a reload,
     * because a freshly pasted picture is drawn by the other path.
     */
    const picture = r.showImage ? r.image : null;
    const named =
      typeof picture === "string"
        ? picture
        : ((picture as { data?: string } | null | undefined)?.data ?? null);
    const shown: ReactNode = named ? (
      <img className="cv-node-image" src={named} alt="" draggable={false} />
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
      }${r.color ? " cv-shaded" : ""}${r.shape && SHAPES[r.shape] ? " cv-shaped" : ""}${
        // The strongest mark on the canvas, and the only filled one — the Mac's
        // reasoning: "dropping a box on a box is a gesture whose outcome is
        // invisible until it has happened … so what it is going to connect to
        // has to be in no doubt before you let go."
        linkTarget === id ? " cv-drop" : ""
      }`}
      style={{
        left: r.x,
        top: r.y,
        width: r.w,
        height: r.h,
        // A note's color is on its paper (above), so the cut corner shows what's
        // behind the note rather than more note.
        // The paper is painted on the sheet inside, never on the frame — see
        // `paperFill`. The frame carried a background for blocks, which put a
        // solid card behind every node whether or not anybody asked for one.
        background: "transparent",
        // Handed to the sheet, which is what carries the colour once a shape
        // has taken it off the frame.
        ...(r.shape && SHAPES[r.shape] ? ({ "--cv-fill": r.color || "var(--surface)" } as React.CSSProperties) : {}),
        /**
         * A shaped node is a frame with a shaped sheet inside it.
         *
         * The clip used to be on this element, and it took the resize corners
         * and connect handles with it — they sit at and outside the node's
         * edges, so clipping the node clipped them away. It also fought the
         * border radius, which is why "Rounded" came out square.
         *
         * The ephemeral note has always done it the other way: the note is only
         * a frame, and `.cv-paper` inside it is what gets cut. Every shape uses
         * that construction now, which is the same reason it was right there.
         */
        ...(r.shape && SHAPES[r.shape] ? { border: "none", background: "transparent", boxShadow: "none" } : {}),
        // A border set by hand lives on the sheet, so the frame stops drawing
        // its own — two outlines a pixel apart is a node that looks doubled.
        ...(borderOf(r) ? { border: "none", boxShadow: "none" } : {}),
      }}
      // Anywhere on a grouped node is a grip. The resize corners and connect
      // handles stop propagation, so they keep their own jobs.
      onPointerDown={(e) => {
        // Add-mode first: while a region is filling, a press on a thing means
        // in-or-out and nothing else. The region stays selected throughout, so
        // its buttons stay put and the mode is visibly still on.
        if (addingTo) {
          e.preventDefault();
          e.stopPropagation();
          toggleMembership(addingTo, id);
          return;
        }
        const group = groupWith(id);
        if (group) return startGroupDrag(group, id, e);
        // A press on the node itself rather than into its text selects it —
        // that's what makes Delete mean this node. A press into a field is
        // writing, and must leave the selection (and Delete) alone.
        const t = e.target as HTMLElement;
        if (!t.closest?.("input, textarea, select, [contenteditable=true]")) {
          setSelected([id]);
          dropCaret();
          // …and moves it. Pressing a different node also puts the last one's
          // words away, so there is never more than one field open and a press
          // is always a drag somewhere.
          if (editingNode !== id) setEditingNode(null);
          startNodeDrag(id, e);
        }
      }}
      onDoubleClick={(e) => {
        if (locked) return;
        const t = e.target as HTMLElement;
        if (t.closest?.(".cv-handle, .cv-corner, .cv-grab")) return;
        setEditingNode(id);
        /*
         * …and the caret goes where the second click landed.
         *
         * The field was inert when that click arrived, so it never saw it: a
         * double-click would open the node and leave you to click a third time.
         * There is nothing to `focus()` either — the note field is a stack of
         * rendered blocks and only becomes a textarea when one is clicked
         * (`notefield.js`), so the click is what has to be replayed.
         *
         * After a paint, because the element only stops being inert once React
         * has written the attribute the stylesheet keys on.
         */
        const { clientX, clientY } = e;
        const node = e.currentTarget as HTMLElement;
        /*
         * The block under the pointer, clicked once it exists.
         *
         * Two things make this awkward and both are timing. `elementFromPoint`
         * looks the obvious way and cannot work: it skips anything with
         * `pointer-events: none`, and the field is still inert on the frame
         * this is scheduled from — so it answers with the body underneath,
         * whose `closest(".note-block")` is nothing. And the blocks themselves
         * are drawn by `notefield.js` after React has re-rendered, so on the
         * next frame there may be nothing to click yet.
         *
         * So: look down from the node, match the point against the blocks' own
         * rectangles, and try again for a few frames if none are there. Bounded,
         * because a node that never grows a block is a picture, and a picture
         * has no words to put a caret in.
         */
        let tries = 12;
        const land = () => {
          const blocks = [...node.querySelectorAll<HTMLElement>(".note-block")];
          if (!blocks.length) {
            if (tries-- > 0) requestAnimationFrame(land);
            return;
          }
          const hit = blocks.find((el) => {
            const r = el.getBoundingClientRect();
            return clientY >= r.top && clientY <= r.bottom;
          });
          (hit ?? blocks[blocks.length - 1]).click();
        };
        requestAnimationFrame(land);
      }}
      {...(editingNode === id ? { "data-editing": "1" } : {})}
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
        style={{
          background: paperFill(r),
          ...(isNote && r.color ? { color: readableOn(r.color) } : {}),
          /*
           * The paper's own color, handed to the stylesheet.
           *
           * The turned corner is drawn from `--cv-fill`, and an ephemeral note
           * never set it — so the fold read the default and a pink sticky grew
           * a yellow corner. The Mac fixed the same thing in its own words: "the
           * paper's own color underneath, so a pink sticky does not grow a
           * yellow corner."
           */
          ...({ "--cv-fill": paperFill(r) } as React.CSSProperties),
          // Where the words sit, and what color they are — see `TalariaInk`.
          ...(r.textColor ? { color: r.textColor } : {}),
          // The user's own border, when they have set one. `border-box` keeps
          // the sheet where it was: it is absolutely positioned to the frame's
          // edges, and a border that grew inward would otherwise move the text.
          ...(borderOf(r) ? { border: borderOf(r), boxSizing: "border-box" as const } : {}),
        }}
      >
        <div className="cv-grab" onPointerDown={(e) => startNodeDrag(id, e)} title="Drag to move">
          <GripHorizontal size={13} />
        </div>
        <div className="cv-body" style={alignment(r)}>{shown}</div>
      </div>
      {/* The outline of a clipped shape, drawn rather than bordered. A sibling
          of the paper, so the clip that cuts the sheet does not cut this —
          which is exactly why a CSS border on an ellipse never appeared, and
          why every width and style looked the same: all of them invisible. */}
      {(() => {
        const d = outlinePath(r.shape, r.w, r.h);
        const width = r.strokeWidth ?? 1;
        if (!d || width === 0) return null;
        const color = r.stroke ?? "var(--border-strong)";
        const style = r.strokeStyle ?? "solid";
        return (
          <svg className="cv-outline" viewBox={`0 0 ${r.w} ${r.h}`} width={r.w} height={r.h}>
            <path d={d} fill="none" stroke={color} strokeWidth={width} strokeDasharray={OUTLINE_DASH[style]} />
            {/* `double` is two lines with a gap between them, which is what the
                CSS keyword draws and what no dash pattern can. The inner one is
                shrunk by four times the stroke so the pair reads as one border
                rather than as two rings. */}
            {style === "double" && (
              <path
                d={d}
                fill="none"
                stroke={color}
                strokeWidth={width}
                transform={
                  `translate(${r.w / 2} ${r.h / 2}) ` +
                  `scale(${Math.max(0.1, (r.w - width * 4) / r.w)} ${Math.max(0.1, (r.h - width * 4) / r.h)}) ` +
                  `translate(${-r.w / 2} ${-r.h / 2})`
                }
              />
            )}
          </svg>
        );
      })()}
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
      // A picture arrives the way one arrives anywhere: pasted, or dropped. A
      // drop lands where it was let go, because somebody dropping a photograph
      // onto a canvas has chosen a place; a paste has no position and lands in
      // the middle of the view, which is where they are looking.
      onPaste={(e) => {
        if (locked) return;
        const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
        if (!file) return;
        e.preventDefault();
        // A paste has no position of its own, so it lands in the middle of
        // what is on screen — which is where somebody pasting is looking.
        void addImageNote(file);
      }}
      onDragOver={(e) => {
        if (!locked && Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (locked) return;
        const file = Array.from(e.dataTransfer.files ?? []).find((f) => f.type.startsWith("image/"));
        if (!file) return;
        e.preventDefault();
        void addImageNote(file, toCanvas(e.clientX, e.clientY));
      }}
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
        // The tool strip makes it, in the shape it is set to — see the note by
        // `dropText`. `addNote` used to be called here and has never existed:
        // `vite build` does not typecheck, so double-clicking blank canvas threw
        // `addNote is not defined` and did nothing, quietly, for as long as this
        // line has been here.
        if (!locked && e.target === e.currentTarget) {
          window.document.dispatchEvent(new CustomEvent("talaria-drop-text", {
            detail: { x: e.clientX, y: e.clientY },
          }));
        }
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
                {/*
                  * The discoverable half of "put things in a box".
                  *
                  * Shown when the region is selected, which is when somebody is
                  * already thinking about this box. Dropping a card in does the
                  * same thing faster; this is how anybody finds out there is
                  * anything to know, and it is the only way to take one thing
                  * out again without deleting it.
                  */}
                {selected.includes(rg.id) && !locked && (
                  <button
                    className={`cv-region-add${addingTo === rg.id ? " on" : ""}`}
                    title={addingTo === rg.id
                      ? "Click things to add or remove them"
                      : "Add things to this region"}
                    onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setAddingTo((a) => (a === rg.id ? null : rg.id));
                    }}
                  >
                    +
                  </button>
                )}
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
              <g
                key={e.id}
                // On the group rather than on the line. Moving from the line
                // onto its own grip is leaving the line, so a hover kept there
                // unmounted the grip at the moment somebody reached for it.
                onPointerEnter={() => setHoverEdge(e.id)}
                onPointerLeave={() => setHoverEdge((h) => (h === e.id ? null : h))}
              >
                <path
                  d={p.d}
                  className="cv-edge-hit"
                  onContextMenu={(ev) => {
                    if (locked) return;
                    ev.preventDefault();
                    setEdgeMenu({ id: e.id, x: ev.clientX, y: ev.clientY });
                  }}
                  onClick={(ev) => !locked && setEdgeMenu({ id: e.id, x: ev.clientX, y: ev.clientY })}
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
                {!locked && (hoverEdge === e.id || bending === e.id) && (
                  <>
                    <circle
                      className="cv-bend"
                      cx={p.mid.x}
                      cy={p.mid.y}
                      r={5 / view.z}
                    />
                    <circle
                      className="cv-bend-hit"
                      cx={p.mid.x}
                      cy={p.mid.y}
                      r={15 / view.z}
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
            n.image ? (
              // Nothing to type into. An image note is the picture and a right
              // click — its words arrive when it becomes a block, in the fields
              // that block has.
              <img className="cv-node-image" src={n.image.data} alt={n.image.name} draggable={false} />
            ) : (
            <EphemeralNote
              text={n.text}
              placeholder="Ephemeral note — right-click to convert"
              autofocus={focusNote === n.id}
              onFocusChange={(f) => f && setEphSel(n.id)}
              onChange={(v) => saveNotes(notes.map((x) => (x.id === n.id ? { ...x, text: v } : x)))}
            />
            ),
            true,
          ),
        )}
      </div>

      {/* inline add search (top left) */}
      {/*
        * **No "Add a block" here.**
        *
        * Hermes' canvas is a view of a collection, so a search that finds a
        * block and drops it in is the natural way to fill one. Talaria's canvas
        * is not that: it is a surface of its own, and what it borrows from the
        * library it borrows through the format. A search box wired straight to
        * Hermes' `/blocks/query` would be the one place on this canvas reaching
        * past the interchange.
        *
        * Blocks still arrive, by the two routes that are specified: the chat,
        * whose `hermes_search` and `hermes_in` run through the daemon — "find my
        * 1Offs tasks and put them on here" — and converting a note, which
        * creates one through `/capture` and the binding.
        */}

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
        {/*
          * **No frosting switch here.** It is one setting across the desk's three
          * surfaces, so it lives in the chrome all three share — see `desk.html`.
          * This canvas listens for it and does not offer a second way to set it.
          */}
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
              /*
               * Picture, or words — and which picture.
               *
               * The switch is Hermes' and so is its reasoning; what is new is
               * the list under it. A node can carry several pictures and only
               * one can be the face of it, so the others are named rather than
               * lost: choosing one is choosing what this node *looks like*,
               * which is a fact about the node and not about anything in the
               * library.
               */
              /*
               * The node itself, not just its box.
               *
               * `rectOf` answers the question every line and every drag asks —
               * where is this — and for a note it answers with four numbers.
               * The pictures are on the note, so a menu built from a rectangle
               * finds none and quietly offers nothing.
               */
              const nr = (nodeMenu.id.startsWith("n:")
                ? notes.find((n) => n.id === nodeMenu.id)
                : rectOf(nodeMenu.id)) as NodeCtx | null;
              const all = nr?.images ?? [];
              if (!all.length) return null;
              const showing = nr?.showImage === true;
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
                    <span>{showing ? "Show text instead of the picture" : "Show the picture instead of text"}</span>
                  </button>
                  <button
                    className="menu-item menu-item-icon"
                    onClick={() => {
                      addPictureTo(nodeMenu.id);
                      setNodeMenu(null);
                    }}
                  >
                    <ImageIcon size={14} />
                    <span>Add a picture…</span>
                  </button>
                  {all.length > 1 && (
                    <>
                      <div className="hint" style={{ padding: "4px 10px" }}>Which picture</div>
                      <div className="cv-menu-row">
                        {all.map((name) => (
                          <button
                            key={name}
                            className={`cv-swatch cv-pic${nr?.imageName === name ? " on" : ""}`}
                            title={name}
                            style={{ backgroundImage: `url("${pictureAt(name)}")` }}
                            onClick={() => {
                              choosePicture(nodeMenu.id, name);
                              setNodeMenu(null);
                            }}
                          />
                        ))}
                      </div>
                    </>
                  )}
                </>
              );
            })()}
            {(() => {
              // Read once. Every control below needs the node's current border,
              // and asking four times invites the four answers to disagree.
              const nr = rectOf(nodeMenu.id) as NodeCtx | null;
              const w = nr?.strokeWidth ?? null;
              const st = nr?.strokeStyle ?? "solid";
              // A width nobody has chosen is the hairline the node already has,
              // so that is what the row shows as current — not "none".
              const shownW = w ?? 1;
              return (
                <>
                  <div className="menu-sep" />
                  <div className="hint" style={{ padding: "4px 10px" }}>Border weight</div>
                  <div className="cv-menu-row">
                    {BORDER_WIDTHS.map((bw) => (
                      <button
                        key={bw}
                        className={`cv-swatch cv-border-swatch${shownW === bw ? " is-on" : ""}`}
                        title={bw === 0 ? "No border" : `${bw}px`}
                        data-w={bw}
                        onClick={() => setBorder(nodeMenu.id, { strokeWidth: bw })}
                      />
                    ))}
                    <label className="cv-swatch cv-swatch-custom" title="Border color…">
                      <Pipette size={12} />
                      <input
                        type="color"
                        value={nr?.stroke ?? "#5f6b74"}
                        onChange={(e) =>
                          // Colouring a border there is none of has to make one,
                          // or the click changes nothing and reads as broken.
                          setBorder(nodeMenu.id, { stroke: e.target.value, strokeWidth: w || 1 })
                        }
                      />
                    </label>
                  </div>
                  <div className="hint" style={{ padding: "4px 10px" }}>Border style</div>
                  <div className="cv-menu-row">
                    {BORDER_STYLES.map((bs) => (
                      <button
                        key={bs}
                        className={`cv-swatch cv-border-swatch${st === bs && shownW > 0 ? " is-on" : ""}`}
                        title={bs}
                        data-style={bs}
                        onClick={() => setBorder(nodeMenu.id, { strokeStyle: bs, strokeWidth: w || 1 })}
                      />
                    ))}
                  </div>
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
            {/*
              * **No Live/Ephemeral here.**
              *
              * In Hermes the distinction is real: a live edge *is* a relation
              * between two blocks and shows in both their info panels, while an
              * ephemeral one is decoration on the collection. Talaria's canvas
              * has only the second kind. Its lines live in `canvas.json`, which
              * has no word for a relation and no business inventing one — the
              * format is where a connection between blocks would be said, and
              * saying it here would be Talaria writing to Hermes around the
              * interchange.
              *
              * So the control is gone rather than disabled. A switch that can
              * only ever be on one setting is a question with one answer.
              */}
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
