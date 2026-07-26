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

/**
 * Obsidian-style connection graph for the currently selected block. Nodes are
 * the block and its connections out to N generations; a force layout gives the
 * organic web. Click a node to navigate to it (info pane + history) and recenter
 * the graph on it. Pan by dragging the background, zoom with the wheel / pinch /
 * the bottom-right controls.
 */
export function GraphPanel() {
  const { selectedBlockId, selectBlock } = usePanels();
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
      onPick={(n) => selectBlock(n.id, { collection: n.collection })}
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
  const posRef = useRef<Map<string, Pt>>(new Map());
  const [, setTick] = useState(0);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });

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

  // Force simulation (cooling), driven by rAF; pins the root at the origin.
  useEffect(() => {
    if (!nodes.length) return;
    let raf = 0;
    let alpha = 1;
    const K = 78; // ideal edge length
    const step = () => {
      const pos = posRef.current;
      const arr = nodes.map((n) => pos.get(n.id)!).filter(Boolean);
      // Repulsion (all pairs).
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
      // Spring on edges.
      for (const e of edges) {
        const a = pos.get(e.a);
        const b = pos.get(e.b);
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
      // Gravity toward center + integrate.
      for (const n of nodes) {
        const p = pos.get(n.id)!;
        p.vx -= p.x * 0.012;
        p.vy -= p.y * 0.012;
        p.x += p.vx * alpha * 0.2;
        p.y += p.vy * alpha * 0.2;
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
      alpha *= 0.985;
      setTick((t) => t + 1);
      if (alpha > 0.02) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // ── Pan / zoom ────────────────────────────────────────────────
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const pinch = useRef<{ d: number; k: number } | null>(null);
  const zoomAt = (factor: number, cx?: number, cy?: number) => {
    const el = wrapRef.current;
    const rect = el?.getBoundingClientRect();
    const ox = cx ?? (rect ? rect.width / 2 : 0);
    const oy = cy ?? (rect ? rect.height / 2 : 0);
    setView((v) => {
      const k = Math.min(4, Math.max(0.2, v.k * factor));
      const s = k / v.k;
      return { k, x: ox - (ox - v.x) * s, y: oy - (oy - v.y) * s };
    });
  };
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const rect = wrapRef.current?.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.1 : 0.9, rect ? e.clientX - rect.left : undefined, rect ? e.clientY - rect.top : undefined);
  };
  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX - view.x, y: e.clientY - view.y, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const nx = e.clientX - drag.current.x;
    const ny = e.clientY - drag.current.y;
    if (Math.abs(e.clientX - drag.current.x - view.x) + Math.abs(e.clientY - drag.current.y - view.y) > 2)
      drag.current.moved = true;
    setView((v) => ({ ...v, x: nx, y: ny }));
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const view0 = { tx: view.x, ty: view.y, k: view.k };
  const rect = wrapRef.current?.getBoundingClientRect();
  const cx = (rect?.width ?? 320) / 2;
  const cy = (rect?.height ?? 400) / 2;

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
        className="graph-svg"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <g transform={`translate(${cx + view0.tx}, ${cy + view0.ty}) scale(${view0.k})`}>
          {edges.map((e, i) => {
            const a = posRef.current.get(e.a);
            const b = posRef.current.get(e.b);
            if (!a || !b) return null;
            return <line key={i} className="graph-edge" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
          })}
          {nodes.map((n) => {
            const p = posRef.current.get(n.id);
            if (!p) return null;
            const isRoot = n.id === root;
            const rad = isRoot ? 9 : n.collection ? 7 : 6;
            return (
              <g
                key={n.id}
                className={`graph-node${isRoot ? " root" : ""}`}
                transform={`translate(${p.x}, ${p.y})`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!drag.current?.moved) onPick(n);
                }}
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
