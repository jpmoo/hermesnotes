import { GripHorizontal, Minus, Plus, StickyNote } from "lucide-react";
import { createPortal } from "react-dom";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { FilterGroup } from "@hermes/shared";
import { api, type Block, type BlockType, type Collection, type Member } from "../api.ts";
import { oneLineText } from "../lib/display.ts";
import { emptyGroup } from "../lib/filter.ts";
import { BlockIcon } from "../lib/icons.tsx";
import { usePanels } from "../lib/right-panel.tsx";
import { BlockCard } from "./BlockCard.tsx";
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

const DEFAULT_W = 280;
const DEFAULT_H = 190;
const NOTE_W = 200;
const NOTE_H = 120;
const MIN_W = 140;
const MIN_H = 80;
const NODE_COLORS = ["#ffffff", "#fdf3d8", "#e7f1e4", "#e3edf5", "#f5e3e7", "#ece5f6", "#eef4f6"];
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
  const typeById = useMemo(() => new Map(types.map((t) => [t.id, t])), [types]);
  const wrapRef = useRef<HTMLDivElement>(null);

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
  const persistTimer = useRef<ReturnType<typeof setTimeout>>();
  const persistProps = (patch: Record<string, unknown>) => {
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => void api.patch(`/collections/${cid}`, patch), 500);
  };
  const saveNotes = (next: CanvasNote[]) => {
    setNotes(next);
    persistProps({ canvas_notes: next });
  };
  const saveEdges = (next: CanvasEdge[]) => {
    setEdges(next);
    persistProps({ canvas_edges: next });
  };

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
    | { kind: "node"; id: string; dx: number; dy: number; moved: boolean }
    | { kind: "resize"; id: string; corner: string; start: Rect; sx: number; sy: number }
    | null
  >(null);
  const [linking, setLinking] = useState<{ from: string; side: Side; x: number; y: number } | null>(null);
  const hoverNode = useRef<string | null>(null);

  const setZoomAt = (nz: number, sx: number, sy: number) => {
    const z = Math.min(3, Math.max(0.1, nz));
    const r = wrapRef.current!.getBoundingClientRect();
    const px = sx - r.left;
    const py = sy - r.top;
    setView((v) => ({
      z,
      x: px - ((px - v.x) / v.z) * z,
      y: py - ((py - v.y) / v.z) * z,
    }));
  };

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    // Native listener: React's wheel is passive, and we must preventDefault
    // to stop page scroll / browser zoom. Two-finger swipe pans; pinch
    // (ctrlKey wheel) or ⌘/Ctrl+wheel zooms.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        setZoomAt(view.z * Math.exp(-e.deltaY * 0.008), e.clientX, e.clientY);
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.z]);

  const onBgPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    if (e.target !== e.currentTarget) return;
    drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, moved: false };
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
    if (d.kind === "node" && d.moved) {
      const r = rectOf(d.id);
      if (!r) return;
      if (d.id.startsWith("n:")) persistProps({ canvas_notes: notes });
      else persistMemberCtx(d.id, r as NodeCtx);
    } else if (d.kind === "resize") {
      const r = rectOf(d.id);
      if (!r) return;
      if (d.id.startsWith("n:")) persistProps({ canvas_notes: notes });
      else persistMemberCtx(d.id, r as NodeCtx);
    }
  };

  const startNodeDrag = (id: string, e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const p = toCanvas(e.clientX, e.clientY);
    const r = rectOf(id);
    if (!r) return;
    drag.current = { kind: "node", id, dx: p.x - r.x, dy: p.y - r.y, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const startResize = (id: string, corner: string, e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const r = rectOf(id);
    if (!r) return;
    drag.current = { kind: "resize", id, corner, start: { ...r }, sx: e.clientX, sy: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  // ── menus ──
  const [nodeMenu, setNodeMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [edgeMenu, setEdgeMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!nodeMenu && !edgeMenu) return;
    const close = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest(".cv-menu")) {
        setNodeMenu(null);
        setEdgeMenu(null);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [nodeMenu, edgeMenu]);

  const removeNode = async (id: string) => {
    if (id.startsWith("n:")) {
      saveNotes(notes.filter((n) => n.id !== id));
    } else {
      const dismissed = Array.isArray(props.canvas_dismissed) ? (props.canvas_dismissed as string[]) : [];
      persistProps({ canvas_dismissed: [...new Set([...dismissed, id])] });
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
    // Remap edges from the ephemeral id to the real block.
    saveEdges(edges.map((e) => ({
      ...e,
      from: e.from === note.id ? b.id : e.from,
      to: e.to === note.id ? b.id : e.to,
    })));
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
      className={`cv-node${isNote ? " cv-note" : ""}`}
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
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerDown={onBgPointerDown}
      onDoubleClick={(e) => {
        if (e.target === e.currentTarget) addNote(toCanvas(e.clientX, e.clientY));
      }}
    >
      <div className="cv-layer" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
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

        {notes.map((n) =>
          nodeBox(
            n.id,
            n,
            <textarea
              className="cv-note-text"
              value={n.text}
              placeholder="Ephemeral note — right-click to convert"
              onChange={(e) => saveNotes(notes.map((x) => (x.id === n.id ? { ...x, text: e.target.value } : x)))}
            />,
            true,
          ),
        )}
      </div>

      {/* toolbar */}
      <div className="cv-toolbar">
        <button className="icon-btn" title="Zoom out" onClick={() => setZoomAt(view.z / 1.2, innerWidth / 2, innerHeight / 2)}>
          <Minus size={14} />
        </button>
        <input
          className="cv-zoom"
          value={`${zoomPct}%`}
          onChange={(e) => {
            const n = Number(e.target.value.replace(/[^\d]/g, ""));
            if (n >= 10 && n <= 300) setZoomAt(n / 100, innerWidth / 2, innerHeight / 2);
          }}
        />
        <button className="icon-btn" title="Zoom in" onClick={() => setZoomAt(view.z * 1.2, innerWidth / 2, innerHeight / 2)}>
          <Plus size={14} />
        </button>
        <span className="cv-tb-sep" />
        <button className="ghost" onClick={() => addNote()}>
          <StickyNote size={14} /> Note
        </button>
        <span className="hint">Drag space to pan · wheel to zoom · double-click for a note</span>
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
