import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { FieldDef } from "@hermes/shared";
import { GripVertical } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { BlockType } from "../api.ts";
import { oneLineText } from "./display.ts";

/** Minimal shape a viewable block must expose. Both Block and Member satisfy it. */
interface Viewable {
  id: string;
  blockTypeId: string | null;
  properties: Record<string, unknown>;
  content: string | null;
  createdAt: string;
  updatedAt: string;
}

type SortKey = "alpha" | "created" | "edited" | `prop:${string}`;
interface SortLevel {
  key: SortKey;
  dir: "asc" | "desc";
}
type ViewMode = "block" | "masonry" | "masonry-collapsed";

const VIEW_KEY = "hn.blockview.mode";
const COLS_KEY = "hn.blockview.cols";
const pretty = (k: string) => k.replace(/_/g, " ");

const readLS = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const writeLS = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
};

/** Field keys shared by the schemas of every block type present in `items`. */
function commonFields(items: Viewable[], types: BlockType[]): FieldDef[] {
  const typeById = new Map(types.map((t) => [t.id, t]));
  const presentIds = [...new Set(items.map((i) => i.blockTypeId))];
  let common: FieldDef[] | null = null;
  for (const id of presentIds) {
    const t = id ? typeById.get(id) : undefined;
    const fields =
      t && !t.isText && t.propertySchema
        ? t.propertySchema.fields.filter((f) => f.key !== "title")
        : [];
    common = common === null ? fields : common.filter((c) => fields.some((f) => f.key === c.key));
    if (common.length === 0) break;
  }
  return common ?? [];
}

function valueFor(b: Viewable, key: SortKey): string {
  if (key === "alpha") return oneLineText(b.properties, b.content).toLowerCase();
  if (key === "created") return b.createdAt;
  if (key === "edited") return b.updatedAt;
  const v = b.properties[key.slice(5)];
  return v == null ? "" : String(v);
}

/** One draggable row in manual mode: a grip handle plus the card. */
function ManualRow({ id, children }: { id: string; children: ReactNode }) {
  const s = useSortable({ id });
  const style = { transform: CSS.Transform.toString(s.transform), transition: s.transition };
  return (
    <div ref={s.setNodeRef} style={style} className="bv-manual-row">
      <button className="drag-handle bv-grip" {...s.attributes} {...s.listeners} title="Drag to arrange">
        <GripVertical size={15} />
      </button>
      <div className="bv-manual-body">{children}</div>
    </div>
  );
}

/**
 * Sort + view controls for a block list. Sort keys: alphabetical, created,
 * edited, and any property common to all represented types. Every list can also
 * switch to **Manual** — drag blocks into place. Manual order persists via the
 * caller's `manual.onMove` (e.g. a document's membership order) or, when a
 * `scope` is given, in localStorage for that view. View modes: block list and
 * masonry (natural / constant height) with a persistent column count.
 */
export function useBlockView<T extends Viewable>(
  items: T[],
  types: BlockType[],
  opts: {
    enableView?: boolean;
    scope?: string;
    manual?: { onMove: (activeId: string, overId: string) => void } | null;
  } = {},
): {
  sorted: T[];
  active: boolean;
  toolbar: ReactNode;
  renderList: (renderCard: (item: T) => ReactNode) => ReactNode;
} {
  const enableView = opts.enableView ?? true;
  const externalManual = opts.manual ?? null;
  // Manual is offered when the caller wires persistence (onMove) or names a
  // scope (localStorage-backed order).
  const manualAvailable = Boolean(externalManual) || Boolean(opts.scope);
  const manualKey = opts.scope ? `hn.bv.manual.${opts.scope}` : "";
  const orderKey = opts.scope ? `hn.bv.order.${opts.scope}` : "";

  const [levels, setLevels] = useState<SortLevel[]>([]);
  const [manualMode, setManualModeState] = useState<boolean>(
    () => manualAvailable && (externalManual ? true : readLS(manualKey) === "1"),
  );
  const [localOrder, setLocalOrder] = useState<string[]>(() => {
    try {
      return orderKey ? (JSON.parse(readLS(orderKey) || "[]") as string[]) : [];
    } catch {
      return [];
    }
  });
  const [viewMode, setViewModeState] = useState<ViewMode>(
    () => (readLS(VIEW_KEY) as ViewMode) || "block",
  );
  const [columns, setColumnsState] = useState<number>(() => Number(readLS(COLS_KEY)) || 3);

  const setViewMode = (v: ViewMode) => {
    setViewModeState(v);
    writeLS(VIEW_KEY, v);
  };
  const setColumns = (n: number) => {
    const c = Math.min(6, Math.max(1, n));
    setColumnsState(c);
    writeLS(COLS_KEY, String(c));
  };
  const setManualMode = (on: boolean) => {
    setManualModeState(on);
    if (manualKey) writeLS(manualKey, on ? "1" : "0");
  };

  const fields = useMemo(() => commonFields(items, types), [items, types]);
  const options = useMemo(
    () => [
      { key: "alpha" as SortKey, label: "Alphabetical" },
      { key: "created" as SortKey, label: "Created" },
      { key: "edited" as SortKey, label: "Edited" },
      ...fields.map((f) => ({
        key: `prop:${f.key}` as SortKey,
        label: f.label?.trim() || pretty(f.key),
      })),
    ],
    [fields],
  );

  const sortActive = !manualMode && levels.length > 0;
  const sorted = useMemo(() => {
    if (manualMode) {
      if (externalManual) return items; // caller controls order
      const idx = new Map(localOrder.map((id, i) => [id, i]));
      return [...items].sort((a, b) => (idx.get(a.id) ?? 1e9) - (idx.get(b.id) ?? 1e9));
    }
    if (levels.length === 0) return items;
    const copy = [...items];
    copy.sort((a, b) => {
      for (const lv of levels) {
        const va = valueFor(a, lv.key);
        const vb = valueFor(b, lv.key);
        if (va === "" || vb === "") {
          if (va === "" && vb === "") continue;
          return va === "" ? 1 : -1; // empties last
        }
        const na = Number(va);
        const nb = Number(vb);
        let r: number;
        if (lv.key !== "alpha" && va.trim() !== "" && !Number.isNaN(na) && !Number.isNaN(nb)) {
          r = na - nb;
        } else {
          r = va.localeCompare(vb);
        }
        if (r !== 0) return lv.dir === "desc" ? -r : r;
      }
      return 0;
    });
    return copy;
  }, [items, levels, manualMode, externalManual, localOrder]);

  const addLevel = () => {
    const used = new Set(levels.map((l) => l.key));
    const next = options.find((o) => !used.has(o.key)) ?? options[0];
    if (next) setLevels((ls) => [...ls, { key: next.key, dir: "asc" }]);
  };
  const setLevel = (i: number, patch: Partial<SortLevel>) =>
    setLevels((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const removeLevel = (i: number) => setLevels((ls) => ls.filter((_, idx) => idx !== i));

  const toggleManual = () => {
    const on = !manualMode;
    if (on) {
      setLevels([]);
      // Seed the local order from the current display so drag starts where things are.
      if (!externalManual) {
        const next = sorted.map((it) => it.id);
        setLocalOrder(next);
        if (orderKey) writeLS(orderKey, JSON.stringify(next));
      }
    }
    setManualMode(on);
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    if (externalManual) {
      externalManual.onMove(String(active.id), String(over.id));
      return;
    }
    const ids = sorted.map((it) => it.id);
    const oldI = ids.indexOf(String(active.id));
    const newI = ids.indexOf(String(over.id));
    if (oldI < 0 || newI < 0) return;
    const next = arrayMove(ids, oldI, newI);
    setLocalOrder(next);
    if (orderKey) writeLS(orderKey, JSON.stringify(next));
  };

  const VIEWS: { key: ViewMode; label: string }[] = [
    { key: "block", label: "Block" },
    { key: "masonry", label: "Masonry" },
    { key: "masonry-collapsed", label: "Masonry (compact)" },
  ];

  const toolbar = (
    <div className="sort-bar">
      {manualAvailable && (
        <button
          className={`seg bv-manual-toggle${manualMode ? " active" : ""}`}
          onClick={toggleManual}
        >
          Manual
        </button>
      )}

      {manualMode ? (
        <span className="hint">Drag blocks into place</span>
      ) : (
        <>
          <span className="sort-label">Sort</span>
          {levels.map((lv, i) => (
            <span className="sort-level" key={i}>
              {i > 0 && <span className="sort-then">then</span>}
              <select
                value={lv.key}
                onChange={(e) => setLevel(i, { key: e.target.value as SortKey })}
              >
                {options.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
              <button
                className="icon-btn sort-dir"
                title={lv.dir === "asc" ? "Ascending" : "Descending"}
                onClick={() => setLevel(i, { dir: lv.dir === "asc" ? "desc" : "asc" })}
              >
                {lv.dir === "asc" ? "↑" : "↓"}
              </button>
              <button className="icon-btn" title="Remove" onClick={() => removeLevel(i)}>
                ✕
              </button>
            </span>
          ))}
          <button className="ghost sort-add" onClick={addLevel}>
            {levels.length > 0 ? "+ level" : "+ Sort"}
          </button>
          {levels.length > 0 && (
            <button className="ghost" onClick={() => setLevels([])} title="Clear sort">
              Clear
            </button>
          )}
        </>
      )}

      {enableView && !manualMode && (
        <span className="view-controls">
          <div className="segmented">
            {VIEWS.map((v) => (
              <button
                key={v.key}
                className={`seg${viewMode === v.key ? " active" : ""}`}
                onClick={() => setViewMode(v.key)}
              >
                {v.label}
              </button>
            ))}
          </div>
          {viewMode !== "block" && (
            <span className="cols-ctl">
              <span className="hint">Cols</span>
              <button className="icon-btn" onClick={() => setColumns(columns - 1)} title="Fewer columns">
                −
              </button>
              <span className="cols-n">{columns}</span>
              <button className="icon-btn" onClick={() => setColumns(columns + 1)} title="More columns">
                +
              </button>
            </span>
          )}
        </span>
      )}
    </div>
  );

  const renderList = (renderCard: (item: T) => ReactNode): ReactNode => {
    if (manualMode) {
      return (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={sorted.map((it) => it.id)} strategy={verticalListSortingStrategy}>
            <div className="bv-manual-list">
              {sorted.map((it) => (
                <ManualRow key={it.id} id={it.id}>
                  {renderCard(it)}
                </ManualRow>
              ))}
            </div>
          </SortableContext>
        </DndContext>
      );
    }
    if (!enableView || viewMode === "block") {
      return (
        <div className="block-stack">
          {sorted.map((it) => (
            <div key={it.id}>{renderCard(it)}</div>
          ))}
        </div>
      );
    }
    const cls = "masonry" + (viewMode === "masonry-collapsed" ? " collapsed" : "");
    return (
      <div className={cls} style={{ columnCount: columns }}>
        {sorted.map((it) => (
          <div className="masonry-item" key={it.id}>
            {renderCard(it)}
          </div>
        ))}
      </div>
    );
  };

  return { sorted, active: sortActive, toolbar, renderList };
}
