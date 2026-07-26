import { Minus, Plus, Maximize2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type GraphNode, type GraphResult } from "../api.ts";
import { usePanels } from "../lib/right-panel.tsx";

interface Pt {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

type Gesture =
  | { mode: "pan"; sx: number; sy: number; vx: number; vy: number; moved: boolean }
  | { mode: "node"; id: string; offX: number; offY: number; tx: number; ty: number; downX: number; downY: number; moved: boolean };

/**
 * Obsidian-style connection graph for the currently selected block. Nodes are
 * the block and its connections out to N generations; a force layout gives the
 * organic web. Click a node to navigate to it (info pane + history) and recenter
 * the graph on it. Pan by dragging the background, zoom with the wheel / pinch /
 * the bottom-right controls.
 */
export function GraphPanel() {
  const { selectedBlockId, openBlock } = usePanels();
  const [depth, setDepth] = useState(1);
  const [data, setData] = useState<GraphResult | null>(null);
  const [loading, setLoading] = useState(false);

  const root = selectedBlockId;

  useEffect(() => {
    if (!root) {
      setData(null);
      return;
    }
    let alive = true;
    setLoading(true);
    void api
      .get<GraphResult>(`/blocks/${root}/graph?depth=${depth}`)
      .then((r) => alive && setData(r))
      .catch(() => alive && setData(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [root, depth]);

  if (!root) {
    return (
      <div className="graph-empty">Select a block or collection to see its connections here.</div>
    );
  }
  return (
    <GraphCanvas
      key={root}
      data={data}
      loading={loading}
      root={root}
      depth={depth}
      onDepth={setDepth}
      onPick={(n) => openBlock(n.id, { collection: n.collection })}
    />
  );
}

function GraphCanvas({
  data,
  loading,
  root,
  depth,
  onDepth,
  onPick,
}: {
  data: GraphResult | null;
  loading: boolean;
  root: string;
  depth: number;
  onDepth: (d: number) => void;
  onPick: (n: GraphNode) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const posRef = useRef<Map<string, Pt>>(new Map());
  const [, setTick] = useState(0);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const gesture = useRef<Gesture | null>(null);
  const alphaRef = useRef(1);
  const reheatRef = useRef<(a?: number) => void>(() => {});

  const nodes = data?.nodes ?? [];
  const edges = data?.edges ?? [];
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // Seed positions for the current node set (ring per generation), keeping any
  // node we already have a position for.
  useEffect(() => {
    const pos = posRef.current;
    const next = new Map<string, Pt>();
    nodes.forEach((n, i) => {
      const prev = pos.get(n.id);
      if (prev) {
        next.set(n.id, prev);
      } else {
        const ring = (n.gen + 1) * 90;
        const theta = (i * 2.399963) % (Math.PI * 2); // golden-angle spread
        next.set(n.id, { x: Math.cos(theta) * ring, y: Math.sin(theta) * ring, vx: 0, vy: 0 });
      }
    });
    const r = next.get(root);
    if (r) {
      r.x = 0;
      r.y = 0;
    }
    posRef.current = next;
    setView({ x: 0, y: 0, k: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Force simulation (cooling), driven by rAF; pins the root at the origin and
  // whichever node is being dragged. `reheatRef` lets interaction wake it up.
  useEffect(() => {
    if (!nodes.length) return;
    let raf = 0;
    let running = true;
    const K = 78; // ideal edge length
    const step = () => {
      const a0 = alphaRef.current;
      const pos = posRef.current;
      const arr = nodes.map((n) => pos.get(n.id)!).filter(Boolean);
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const a = arr[i]!;
          const b = arr[j]!;
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) {
            dx = (i - j) * 0.1 + 0.1;
            dy = 0.1;
            d2 = dx * dx + dy * dy;
          }
          const f = (K * K) / d2;
          const d = Math.sqrt(d2);
          const fx = (dx / d) * f;
          const fy = (dy / d) * f;
          a.vx += fx;
          a.vy += fy;
          b.vx -= fx;
          b.vy -= fy;
        }
      }
      for (const e of edges) {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 0.01;
        const f = (d - K) * 0.05;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
      for (const n of nodes) {
        const p = pos.get(n.id)!;
        p.vx -= p.x * 0.012;
        p.vy -= p.y * 0.012;
        p.x += p.vx * a0 * 0.2;
        p.y += p.vy * a0 * 0.2;
        p.vx *= 0.82;
        p.vy *= 0.82;
      }
      const r = pos.get(root);
      if (r) {
        r.x = 0;
        r.y = 0;
        r.vx = 0;
        r.vy = 0;
      }
      // Pin the dragged node to the cursor.
      const g = gesture.current;
      if (g?.mode === "node") {
        const p = pos.get(g.id);
        if (p) {
          p.x = g.tx;
          p.y = g.ty;
          p.vx = 0;
          p.vy = 0;
        }
      }
      alphaRef.current = a0 * 0.985;
      setTick((t) => t + 1);
      const dragging = gesture.current?.mode === "node";
      if (alphaRef.current > 0.02 || dragging) raf = requestAnimationFrame(step);
      else running = false;
    };
    const ensure = () => {
      if (!running) {
        running = true;
        raf = requestAnimationFrame(step);
      }
    };
    reheatRef.current = (a = 0.5) => {
      alphaRef.current = Math.max(alphaRef.current, a);
      ensure();
    };
    alphaRef.current = 1;
    raf = requestAnimationFrame(step);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
      reheatRef.current = () => {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // ── Pan / zoom / node-drag ────────────────────────────────────
  const geom = () => {
    const r = svgRef.current?.getBoundingClientRect();
    return { r, cx: (r?.width ?? 320) / 2, cy: (r?.height ?? 400) / 2 };
  };
  const toGraph = (clientX: number, clientY: number) => {
    const { r, cx, cy } = geom();
    const v = viewRef.current;
    if (!r) return { x: 0, y: 0 };
    return { x: (clientX - r.left - cx - v.x) / v.k, y: (clientY - r.top - cy - v.y) / v.k };
  };
  // Zoom around a focus point expressed relative to the transform center
  // (i.e. cursor − center); default (0,0) zooms around the middle.
  const zoomAt = (factor: number, fx = 0, fy = 0) => {
    setView((v) => {
      const k = Math.min(4, Math.max(0.2, v.k * factor));
      const s = k / v.k;
      return { k, x: fx - (fx - v.x) * s, y: fy - (fy - v.y) * s };
    });
  };
  // The cursor position relative to the transform center, for cursor-anchored zoom.
  const focusOf = (clientX: number, clientY: number): [number, number] => {
    const { r, cx, cy } = geom();
    if (!r) return [0, 0];
    return [clientX - r.left - cx, clientY - r.top - cy];
  };
  // Trackpad: pinch arrives as ctrl+wheel → zoom; a two-finger swipe → pan.
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    if (e.ctrlKey) {
      zoomAt(Math.exp(-e.deltaY * 0.01), ...focusOf(e.clientX, e.clientY));
    } else {
      setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    }
  };
  const onPointerDown = (e: React.PointerEvent) => {
    svgRef.current?.setPointerCapture?.(e.pointerId);
    const nodeEl = (e.target as Element).closest?.("[data-node]");
    const id = nodeEl?.getAttribute("data-node") ?? "";
    const p = posRef.current.get(id);
    if (id && p) {
      const gp = toGraph(e.clientX, e.clientY);
      gesture.current = { mode: "node", id, offX: p.x - gp.x, offY: p.y - gp.y, tx: p.x, ty: p.y, downX: e.clientX, downY: e.clientY, moved: false };
      reheatRef.current(0.6);
    } else {
      const v = viewRef.current;
      gesture.current = { mode: "pan", sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y, moved: false };
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    if (g.mode === "pan") {
      const dx = e.clientX - g.sx;
      const dy = e.clientY - g.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) g.moved = true;
      setView((v) => ({ ...v, x: g.vx + dx, y: g.vy + dy }));
    } else {
      const gp = toGraph(e.clientX, e.clientY);
      g.tx = gp.x + g.offX;
      g.ty = gp.y + g.offY;
      if (Math.abs(e.clientX - g.downX) + Math.abs(e.clientY - g.downY) > 3) g.moved = true;
      reheatRef.current(0.3);
    }
  };
  const onPointerUp = () => {
    const g = gesture.current;
    gesture.current = null;
    if (g?.mode === "node") {
      if (!g.moved) {
        const n = nodeById.get(g.id);
        if (n) onPick(n);
      } else {
        reheatRef.current(0.25); // let neighbors relax after a drag
      }
    }
  };

  const { cx, cy } = geom();
  const view0 = { tx: view.x, ty: view.y, k: view.k };
  const radOf = (id: string) => {
    const n = nodeById.get(id);
    return n ? (n.id === root ? 9 : n.collection ? 7 : 6) : 6;
  };

  return (
    <div className="graph-canvas" ref={wrapRef} onWheel={onWheel}>
      <div className="graph-toolbar">
        <span className="graph-depth-label">Depth</span>
        <span className="segmented graph-depth">
          {[1, 2, 3, 4, 5].map((d) => (
            <button key={d} className={`seg${depth === d ? " active" : ""}`} onClick={() => onDepth(d)}>
              {d}
            </button>
          ))}
        </span>
        {loading && <span className="hint graph-loading">loading…</span>}
        {data?.truncated && <span className="hint graph-trunc" title="Graph capped">capped</span>}
      </div>

      <svg
        ref={svgRef}
        className="graph-svg"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <defs>
          <marker
            id="garrow"
            viewBox="0 0 8 8"
            markerWidth="8"
            markerHeight="8"
            refX="7"
            refY="4"
            orient="auto"
          >
            <path className="graph-arrow" d="M0,0 L8,4 L0,8 z" />
          </marker>
        </defs>
        <g transform={`translate(${cx + view0.tx}, ${cy + view0.ty}) scale(${view0.k})`}>
          {edges.map((e, i) => {
            const a = posRef.current.get(e.from);
            const b = posRef.current.get(e.to);
            if (!a || !b) return null;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const len = Math.hypot(dx, dy) || 1;
            const ux = dx / len;
            const uy = dy / len;
            const x1 = a.x + ux * (radOf(e.from) + 1);
            const y1 = a.y + uy * (radOf(e.from) + 1);
            const x2 = b.x - ux * (radOf(e.to) + 5);
            const y2 = b.y - uy * (radOf(e.to) + 5);
            return (
              <g key={i}>
                <line className="graph-edge" x1={x1} y1={y1} x2={x2} y2={y2} markerEnd="url(#garrow)" />
                <line className="graph-edge-flow" x1={x1} y1={y1} x2={x2} y2={y2} />
              </g>
            );
          })}
          {nodes.map((n) => {
            const p = posRef.current.get(n.id);
            if (!p) return null;
            const isRoot = n.id === root;
            const rad = isRoot ? 9 : n.collection ? 7 : 6;
            return (
              <g
                key={n.id}
                data-node={n.id}
                className={`graph-node${isRoot ? " root" : ""}`}
                transform={`translate(${p.x}, ${p.y})`}
              >
                <circle
                  r={rad}
                  style={{ fill: n.iconColor ?? (n.collection ? "var(--accent)" : "var(--text-muted)") }}
                />
                <text className="graph-label" x={0} y={rad + 12}>
                  {n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {nodes.length > 0 && !loading && edges.length === 0 && nodes.length === 1 && (
        <div className="graph-note">No connections yet.</div>
      )}

      <div className="graph-zoom">
        <button className="icon-btn" title="Zoom in" onClick={() => zoomAt(1.2)}>
          <Plus size={15} />
        </button>
        <button className="icon-btn" title="Zoom out" onClick={() => zoomAt(0.83)}>
          <Minus size={15} />
        </button>
        <button className="icon-btn" title="Reset" onClick={() => setView({ x: 0, y: 0, k: 1 })}>
          <Maximize2 size={14} />
        </button>
      </div>
    </div>
  );
}
