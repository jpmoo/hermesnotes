import { GripHorizontal, Minus, Plus } from "lucide-react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { FilterGroup } from "@hermes/shared";
import { api, type Block, type BlockSearchResult, type BlockType, type Collection, type Member } from "../api.ts";
import { oneLineText } from "../lib/display.ts";
import { emptyGroup } from "../lib/filter.ts";
import { BlockIcon } from "../lib/icons.tsx";
import { emitBlockChange, useBlockDeleted } from "../lib/block-events.ts";
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
}
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
  /** Live edges are real connections (surface in the info block); ephemeral
   * ones are canvas-only decoration. Absent = live (pre-flag edges). */
  live?: boolean;
}
interface CanvasNote extends Rect {
  id: string; // "n:<uuid>"
  text: string;
  color?: string | null;
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
const MIN_W = 140;
const MIN_H = 80;
const NODE_COLORS = ["#ffffff", "#fdf3d8", "#e7f1e4", "#e3edf5", "#f5e3e7", "#ece5f6", "#eef4f6"];
const REGION_COLORS = [
  "rgba(95, 164, 181, 0.12)",
  "rgba(222, 184, 72, 0.14)",
  "rgba(47, 109, 79, 0.10)",
  "rgba(181, 82, 95, 0.10)",
  "rgba(106, 90, 205, 0.10)",
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
  const wrapRef = useRef<HTMLDivElement>(null);

  // Fill the viewport: measure where the canvas actually starts and take the
  // rest (the CSS calc() is only a first-paint fallback).
  const [wrapH, setWrapH] = useState<number | null>(null);
  useEffect(() => {
    const measure = () => {
      const el = wrapRef.current;
      if (!el) return;
      setWrapH(Math.max(460, window.innerHeight - el.getBoundingClientRect().top - 20));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
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
      ? { x: c.x, y: c.y, w: c.w ?? DEFAULT_W, h: c.h ?? DEFAULT_H, color: c.color ?? null }
      : null;
  };
  // Local position overrides (during + after drags) layered over member context.
  const [local, setLocal] = useState<Record<string, NodeCtx>>({});
  const [notes, setNotes] = useState<CanvasNote[]>(() =>
    Array.isArray(props.canvas_notes) ? (props.canvas_notes as CanvasNote[]) : [],
  );
  const [edges, setEdges] = useState<CanvasEdge[]>(() =>
    Array.isArray(props.canvas_edges) ? (props.canvas_edges as CanvasEdge[]) : [],
  );
  const [regions, setRegions] = useState<CanvasRegion[]>(() =>
    Array.isArray(props.canvas_regions) ? (props.canvas_regions as CanvasRegion[]) : [],
  );
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

  const rectOf = (id: string): Rect | null => {
    if (id.startsWith("n:")) {
      const n = notes.find((x) => x.id === id);
      return n ? { x: n.x, y: n.y, w: n.w, h: n.h } : null;
    }
    const l = local[id];
    if (l) return l;
    const m = members.find((x) => x.id === id);
    return m ? ctxOf(m) : null;
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
    | null
  >(null);
  const [linking, setLinking] = useState<{ from: string; side: Side; x: number; y: number } | null>(null);
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
      // Swiping over a node whose content can scroll in that direction lets
      // the node scroll natively; otherwise the canvas pans.
      const body = (e.target as HTMLElement).closest?.(".cv-body, .cv-add-list");
      if (body && Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
        const canDown = body.scrollTop + body.clientHeight < body.scrollHeight - 1;
        const canUp = body.scrollTop > 0;
        if ((e.deltaY > 0 && canDown) || (e.deltaY < 0 && canUp)) return;
      }
      e.preventDefault();
      setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onBgPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    if (e.target !== e.currentTarget) return;
    e.preventDefault(); // stop text-selection sweeps while panning/selecting
    if (e.shiftKey) {
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
  const onPointerMove = (e: ReactPointerEvent) => {
    if (linking) {
      const p = toCanvas(e.clientX, e.clientY);
      setLinking((l) => (l ? { ...l, x: p.x, y: p.y } : l));
      return;
    }
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
      const ctx = { ...cur, x: p.x - d.dx, y: p.y - d.dy } as NodeCtx;
      if (d.id.startsWith("n:")) setNotes((ns) => ns.map((n) => (n.id === d.id ? { ...n, x: ctx.x, y: ctx.y } : n)));
      else setLocal((prev) => ({ ...prev, [d.id]: ctx }));
    } else if (d.kind === "marquee") {
      const p = toCanvas(e.clientX, e.clientY);
      setMarquee((m) => (m ? { ...m, x2: p.x, y2: p.y } : m));
    } else if (d.kind === "region") {
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
      if (d.id.startsWith("n:"))
        setNotes((ns) => ns.map((n) => (n.id === d.id ? { ...n, ...r } : n)));
      else setLocal((prev) => ({ ...prev, [d.id]: { ...(prev[d.id] ?? (r as NodeCtx)), ...r } }));
    }
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (linking) {
      const target = hoverNode.current;
      if (target && target !== linking.from) {
        // Pick the target side facing the source anchor.
        const tr = rectOf(target);
        const src = rectOf(linking.from);
        if (tr && src) {
          const sa = anchor(src, linking.side);
          const dxc = sa.x - (tr.x + tr.w / 2);
          const dyc = sa.y - (tr.y + tr.h / 2);
          const toSide: Side =
            Math.abs(dxc) / tr.w > Math.abs(dyc) / tr.h ? (dxc > 0 ? "e" : "w") : dyc > 0 ? "s" : "n";
          // A live link needs two real blocks — anything touching an
          // ephemeral note is forced ephemeral (dotted).
          const eph = linking.from.startsWith("n:") || target.startsWith("n:");
          saveEdges([
            ...edges,
            {
              id: uid(),
              from: linking.from,
              to: target,
              fromSide: linking.side,
              toSide,
              arrow: "forward",
              live: !eph,
              ...(eph ? { dash: "dotted" as const } : {}),
            },
          ]);
        }
      }
      setLinking(null);
      return;
    }
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

  const startNodeDrag = (id: string, e: ReactPointerEvent) => {
    if (e.button !== 0) return;
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
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const r = rectOf(id);
    if (!r) return;
    drag.current = { kind: "resize", id, corner, start: { ...r }, sx: e.clientX, sy: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  // ── menus ──
  const [nodeMenu, setNodeMenu] = useState<{ id: string; x: number; y: number } | null>(null);
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

  // Bulk removal (Delete key / Clear): regions dissolve (blocks stay unless
  // themselves selected); block removal is membership-only, never deletion.
  // Focusing an ephemeral note edits it in the panel too — without touching
  // selectBlock, so it never lands in the recents history.
  const [ephSel, setEphSel] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string[] | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
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
    saveNotes([...notes, { id: `n:${uid()}`, ...spot, w: NOTE_W, h: NOTE_H, text: "", color: "#fdf3d8" }]);
  };

  const convertNote = async (note: CanvasNote, type: BlockType) => {
    const text = note.text.trim();
    const firstLine = text.split("\n")[0] ?? "";
    const body = type.isText
      ? { blockTypeId: type.id, content: text }
      : { blockTypeId: type.id, properties: { title: firstLine || "Untitled" } };
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
    const a = anchor(fr, e.fromSide);
    const b = anchor(tr, e.toSide);
    const ext = 46;
    const c1 = { x: a.x + OUT[e.fromSide].x * ext, y: a.y + OUT[e.fromSide].y * ext };
    const c2 = { x: b.x + OUT[e.toSide].x * ext, y: b.y + OUT[e.toSide].y * ext };
    return {
      d: `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`,
      mid: { x: (a.x + b.x) / 2 + (c1.x + c2.x - a.x - b.x) * 0.19, y: (a.y + b.y) / 2 + (c1.y + c2.y - a.y - b.y) * 0.19 },
    };
  };
  const dashOf = (e: CanvasEdge) => (e.dash === "dashed" ? "9 6" : e.dash === "dotted" ? "2 6" : undefined);

  const patchEdge = (id: string, patch: Partial<CanvasEdge>) =>
    saveEdges(edges.map((e) => (e.id === id ? { ...e, ...patch } : e)));

  // ── render ──
  const zoomPct = Math.round(view.z * 100);
  const menuEdge = edgeMenu ? edges.find((e) => e.id === edgeMenu.id) : null;
  const menuNote = nodeMenu?.id.startsWith("n:") ? notes.find((n) => n.id === nodeMenu.id) : null;
  const orderedTypes = [...types].sort((a, b) =>
    a.isText === b.isText ? a.name.localeCompare(b.name) : a.isText ? -1 : 1,
  );

  const nodeBox = (id: string, r: NodeCtx, body: ReactNode, isNote: boolean) => (
    <div
      key={id}
      className={`cv-node${isNote ? " cv-note" : ""}${selected.includes(id) ? " cv-sel" : ""}${r.color ? " cv-shaded" : ""}`}
      style={{
        left: r.x,
        top: r.y,
        width: r.w,
        height: r.h,
        background: r.color || "var(--surface)",
      }}
      onPointerEnter={() => (hoverNode.current = id)}
      onPointerLeave={() => (hoverNode.current = hoverNode.current === id ? null : hoverNode.current)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setNodeMenu({ id, x: e.clientX, y: e.clientY });
      }}
    >
      <div className="cv-grab" onPointerDown={(e) => startNodeDrag(id, e)} title="Drag to move">
        <GripHorizontal size={13} />
      </div>
      <div className="cv-body">{body}</div>
      {(["nw", "ne", "sw", "se"] as const).map((c) => (
        <span key={c} className={`cv-corner cv-${c}`} onPointerDown={(e) => startResize(id, c, e)} />
      ))}
      {(["n", "s", "e", "w"] as const).map((sd) => (
        <span
          key={sd}
          className={`cv-handle cv-h-${sd}`}
          title="Drag to connect"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            const p = toCanvas(e.clientX, e.clientY);
            setLinking({ from: id, side: sd, x: p.x, y: p.y });
          }}
        />
      ))}
    </div>
  );

  return (
    <div
      ref={wrapRef}
      className="cv-wrap"
      style={wrapH != null ? { height: wrapH } : undefined}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerDown={onBgPointerDown}
      onDoubleClick={(e) => {
        if (e.target === e.currentTarget) addNote(toCanvas(e.clientX, e.clientY));
      }}
    >
      <div className="cv-layer" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
        {regions.map((rg) => {
          const rr = regionRect(rg);
          if (!rr) return null;
          return (
            <div
              key={rg.id}
              className="cv-region"
              style={{ left: rr.x, top: rr.y, width: rr.w, height: rr.h, background: rg.color ?? REGION_COLORS[0] }}
              onPointerDown={(e) => startRegionDrag(rg.id, e)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setRegionMenu({ id: rg.id, x: e.clientX, y: e.clientY });
              }}
            >
              <div className="cv-region-title">
                {rg.title || "Region"}
                {rg.linkedCollectionId && <span title="Synced to a collection"> ⟲</span>}
              </div>
            </div>
          );
        })}
        <svg className="cv-svg" width={0} height={0}>
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
                    ev.preventDefault();
                    setEdgeMenu({ id: e.id, x: ev.clientX, y: ev.clientY });
                  }}
                  onClick={(ev) => setEdgeMenu({ id: e.id, x: ev.clientX, y: ev.clientY })}
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
              </g>
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
            <textarea
              className="cv-note-text"
              value={n.text}
              placeholder="Ephemeral note — right-click to convert"
              onFocus={() => setEphSel(n.id)}
              onChange={(e) => saveNotes(notes.map((x) => (x.id === n.id ? { ...x, text: e.target.value } : x)))}
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
        <span className="cv-tb-sep" />
        <button className="ghost" onClick={() => setConfirmClear(true)}>
          Clear
        </button>
      </div>

      {/* node menu */}
      {nodeMenu &&
        createPortal(
          <div className="menu cv-menu" style={{ position: "fixed", left: nodeMenu.x, top: nodeMenu.y, right: "auto" }}>
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
            {menuNote && (
              <>
                <div className="menu-sep" />
                <div className="hint" style={{ padding: "4px 10px" }}>Convert to…</div>
                {orderedTypes.map((t) => (
                  <button
                    key={t.id}
                    className="menu-item"
                    onClick={() => {
                      void convertNote(menuNote, t);
                      setNodeMenu(null);
                    }}
                  >
                    {t.isText ? "Note (text)" : t.name}
                  </button>
                ))}
              </>
            )}
            <div className="menu-sep" />
            <button
              className="menu-item"
              onClick={() => {
                void removeNode(nodeMenu.id);
                setNodeMenu(null);
              }}
            >
              {nodeMenu.id.startsWith("n:") ? "Delete note" : "Remove from canvas"}
            </button>
          </div>,
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
              <textarea
                className="cv-eph-panel"
                value={note.text}
                placeholder="Write…"
                onChange={(e) =>
                  saveNotes(notes.map((x) => (x.id === note.id ? { ...x, text: e.target.value } : x)))
                }
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
        title={`Remove ${confirmRemove?.length ?? 0} item${(confirmRemove?.length ?? 0) === 1 ? "" : "s"} from the canvas?`}
        message="Blocks are only removed from the canvas — they are not deleted. Ephemeral notes and regions are discarded."
        confirmLabel="Remove"
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
            <div
              className="menu cv-menu"
              style={{ position: "fixed", left: regionMenu.x, top: regionMenu.y, right: "auto" }}
            >
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
            </div>,
            document.body,
          );
        })()}

      {/* edge menu */}
      {edgeMenu &&
        menuEdge &&
        createPortal(
          <div className="menu cv-menu" style={{ position: "fixed", left: edgeMenu.x, top: edgeMenu.y, right: "auto" }}>
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
          </div>,
          document.body,
        )}
    </div>
  );
}
