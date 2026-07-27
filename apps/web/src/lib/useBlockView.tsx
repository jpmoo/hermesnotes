import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { FieldDef } from "@hermes/shared";
import { ChevronDown, ChevronUp, GripVertical, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { BlockType } from "../api.ts";
import { oneLineText } from "./display.ts";
import { StatusIcon } from "../components/StatusIcon.tsx";
import { usePanels } from "./right-panel.tsx";
import { useIsMobile } from "./useIsMobile.ts";

/** Minimal shape a viewable block must expose. Both Block and Member satisfy it. */
interface Viewable {
  id: string;
  blockTypeId: string | null;
  properties: Record<string, unknown>;
  content: string | null;
  createdAt: string;
  updatedAt: string;
  version?: number;
}

type SortKey = "alpha" | "created" | "edited" | `prop:${string}`;
interface SortLevel {
  key: SortKey;
  dir: "asc" | "desc";
}
type ViewMode = "block" | "masonry" | "chips";

/** Persistable view selections: canonical on the collection, forkable per embed. */
export interface BlockViewState {
  manual?: boolean;
  sort?: { key: string; dir: "asc" | "desc" }[];
  viewMode?: ViewMode;
}

const VIEW_KEY = "hn.blockview.mode";
const COLS_KEY = "hn.blockview.cols";
const CHIP_COLS_KEY = "hn.blockview.chipcols";
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

/** A masonry card: compact preview. Clicking selects the block, whose full
 * editable card lives in the right panel (no inline expand needed). */
function MasonryCard({ blockId, render }: { blockId: string; render: (compact: boolean) => ReactNode }) {
  const { selectBlock } = usePanels();
  return (
    <div className="masonry-item" onClick={() => selectBlock(blockId)}>
      {render(true)}
    </div>
  );
}

/** Constant-size chip: status/type icon + a slice of the title. Clicking selects
 * the block into the info panel; the status glyph stays interactive. A div (not
 * a button) so the status button isn't nested inside another button. */
function BlockChip({ item, type, grip }: { item: Viewable; type: BlockType | undefined; grip?: ReactNode }) {
  const { selectBlock } = usePanels();
  const text = oneLineText(item.properties, item.content);
  return (
    <div
      className="bv-chip"
      role="button"
      tabIndex={0}
      title={text}
      onClick={() => selectBlock(item.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          selectBlock(item.id);
        }
      }}
    >
      {grip}
      <StatusIcon block={item} type={type} size={15} className="bv-chip-status" />
      <span className="bv-chip-text">{text || <span className="li-empty">Empty</span>}</span>
    </div>
  );
}

/** A draggable chip in manual mode: grip first, then the chip body. */
function ManualChip({ item, type }: { item: Viewable; type: BlockType | undefined }) {
  const s = useSortable({ id: item.id });
  const style = { transform: CSS.Translate.toString(s.transform), transition: s.transition };
  return (
    <div ref={s.setNodeRef} style={style} className="bv-chip-wrap">
      <BlockChip
        item={item}
        type={type}
        grip={
          <span
            className="drag-handle bv-chip-grip"
            {...s.attributes}
            {...s.listeners}
            onClick={(e) => e.stopPropagation()}
            title="Drag to arrange"
          >
            <GripVertical size={13} />
          </span>
        }
      />
    </div>
  );
}

/** One draggable row in manual mode: a grip handle plus the card. */
function ManualRow({ id, children }: { id: string; children: ReactNode }) {
  const s = useSortable({ id });
  // Translate (not Transform) so variable-height cards don't stretch mid-drag.
  const style = { transform: CSS.Translate.toString(s.transform), transition: s.transition };
  return (
    <div ref={s.setNodeRef} style={style} className="bv-manual-row">
      <button className="drag-handle bv-grip" {...s.attributes} {...s.listeners} title="Drag to arrange">
        <GripVertical size={15} />
      </button>
      <div className="bv-manual-body">{children}</div>
    </div>
  );
}

/** A draggable masonry cell in manual mode: the card with a corner grip. */
function ManualMasonryItem({ id, children }: { id: string; children: ReactNode }) {
  const s = useSortable({ id });
  const { selectBlock } = usePanels();
  const style = { transform: CSS.Translate.toString(s.transform), transition: s.transition };
  return (
    <div ref={s.setNodeRef} style={style} className="masonry-item" onClick={() => selectBlock(id)}>
      <button className="drag-handle masonry-grip" {...s.attributes} {...s.listeners} title="Drag to arrange">
        <GripVertical size={15} />
      </button>
      {children}
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
    /** Inherit/persist sort + view selections (collection pages and embeds). */
    viewState?: { initial?: BlockViewState; onChange?: (vs: BlockViewState) => void };
  } = {},
): {
  sorted: T[];
  active: boolean;
  viewMode: ViewMode;
  toolbar: ReactNode;
  renderList: (renderCard: (item: T, compact: boolean) => ReactNode) => ReactNode;
} {
  const enableView = opts.enableView ?? true;
  const externalManual = opts.manual ?? null;
  // Manual is offered when the caller wires persistence (onMove) or names a
  // scope (localStorage-backed order).
  const manualAvailable = Boolean(externalManual) || Boolean(opts.scope);
  const manualKey = opts.scope ? `hn.bv.manual.${opts.scope}` : "";
  const orderKey = opts.scope ? `hn.bv.order.${opts.scope}` : "";
  // View mode + column counts persist per scope (e.g. each type on the Types
  // page keeps its own), falling back to the shared key when no scope is given.
  const scopeSfx = opts.scope ? `.${opts.scope}` : "";
  const viewKey = VIEW_KEY + scopeSfx;
  const vs = opts.viewState;

  const [levels, setLevels] = useState<SortLevel[]>(() => (vs?.initial?.sort as SortLevel[]) ?? []);
  const [manualModeState, setManualModeState] = useState<boolean>(() =>
    manualAvailable &&
    (vs?.initial?.manual !== undefined
      ? vs.initial.manual
      : externalManual
        ? true
        : readLS(manualKey) === "1"),
  );
  // Never manual when it isn't available (e.g. a collection that resolves to
  // dynamic-smart after its members load), regardless of stale state.
  const manualMode = manualModeState && manualAvailable;
  const [localOrder, setLocalOrder] = useState<string[]>(() => {
    try {
      return orderKey ? (JSON.parse(readLS(orderKey) || "[]") as string[]) : [];
    } catch {
      return [];
    }
  });
  const [viewMode, setViewModeState] = useState<ViewMode>(() => {
    const iv = vs?.initial?.viewMode;
    if (iv === "block" || iv === "masonry" || iv === "chips") return iv;
    const v = readLS(viewKey);
    return v === "masonry" || v === "chips" ? v : "block";
  });

  // A collection's state arrives async on its own page: re-seed when the
  // provided initial actually changes (embed callers mount with it in hand).
  const initKey = JSON.stringify(vs?.initial ?? null);
  const seeded = useRef(initKey);
  useEffect(() => {
    if (seeded.current === initKey) return;
    seeded.current = initKey;
    const i = vs?.initial;
    if (!i) return;
    if (i.sort) setLevels(i.sort as SortLevel[]);
    if (i.manual !== undefined && manualAvailable) setManualModeState(i.manual);
    if (i.viewMode) setViewModeState(i.viewMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initKey]);

  /** Report a selection change to the persistence hook (fork or canonical). */
  const reportVS = (patch: BlockViewState) =>
    vs?.onChange?.({ manual: manualMode0(), sort: levels, viewMode, ...patch });
  // manualMode isn't computed yet at definition time — thunk it.
  function manualMode0(): boolean {
    return manualModeState && manualAvailable;
  }
  const isMobile = useIsMobile();
  // Columns persist separately for mobile vs desktop; phones may go to 1.
  const colsKey = (isMobile ? `${COLS_KEY}.m` : COLS_KEY) + scopeSfx;
  const chipColsKey = (isMobile ? `${CHIP_COLS_KEY}.m` : CHIP_COLS_KEY) + scopeSfx;
  const clampCols = (n: number) =>
    isMobile ? Math.min(3, Math.max(1, n || 1)) : Math.min(4, Math.max(2, n || 3));
  const [columns, setColumnsState] = useState<number>(() => clampCols(Number(readLS(colsKey))));
  // Chips are compact, so they take a wider range; the grid stretches them to
  // fill the content width whatever the panels leave available.
  const clampChipCols = (n: number) => Math.min(10, Math.max(1, n || 4));
  const [chipCols, setChipColsState] = useState<number>(() =>
    clampChipCols(Number(readLS(chipColsKey))),
  );
  const setChipCols = (n: number) => {
    const c = clampChipCols(n);
    setChipColsState(c);
    writeLS(chipColsKey, String(c));
  };
  // Re-read the device-appropriate column counts when crossing the breakpoint.
  useEffect(() => {
    setColumnsState(clampCols(Number(readLS(colsKey))));
    setChipColsState(clampChipCols(Number(readLS(chipColsKey))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile]);

  const setViewMode = (v: ViewMode) => {
    setViewModeState(v);
    writeLS(viewKey, v);
    reportVS({ viewMode: v });
  };
  const setColumns = (n: number) => {
    const c = clampCols(n);
    setColumnsState(c);
    writeLS(colsKey, String(c));
  };
  const setManualMode = (on: boolean) => {
    setManualModeState(on);
    if (manualKey) writeLS(manualKey, on ? "1" : "0");
  };

  const fields = useMemo(() => commonFields(items, types), [items, types]);
  const typeById = useMemo(() => new Map(types.map((t) => [t.id, t])), [types]);
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

  const applyLevels = (next: SortLevel[]) => {
    setLevels(next);
    reportVS({ sort: next });
  };
  const addLevel = () => {
    const used = new Set(levels.map((l) => l.key));
    const next = options.find((o) => !used.has(o.key)) ?? options[0];
    if (next) applyLevels([...levels, { key: next.key, dir: "asc" }]);
  };
  const setLevel = (i: number, patch: Partial<SortLevel>) =>
    applyLevels(levels.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const removeLevel = (i: number) => applyLevels(levels.filter((_, idx) => idx !== i));

  const chooseManual = (on: boolean) => {
    if (on === manualMode) return;
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
    reportVS({ manual: on, sort: on ? [] : levels });
  };

  // Mouse: drag after a small move. Touch: press-and-hold (delay) so a normal
  // swipe still scrolls the list — a plain pointer sensor hijacked scrolling on
  // phones, which is why manual sort felt broken there.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
  );
  // On phones the sort/view controls collapse behind a handle to save space.
  const [toolsOpen, setToolsOpen] = useState(false);
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
    { key: "chips", label: "Chips" },
  ];

  const sortBar = (
    <div className="sort-bar">
      {manualAvailable ? (
        <div className="segmented">
          <button
            className={`seg${manualMode ? " active" : ""}`}
            onClick={() => chooseManual(true)}
          >
            Manual sort
          </button>
          <button
            className={`seg${!manualMode ? " active" : ""}`}
            onClick={() => chooseManual(false)}
          >
            Properties sort
          </button>
        </div>
      ) : (
        <span className="sort-label">sort</span>
      )}

      {manualMode ? (
        <span className="hint">Drag blocks into place</span>
      ) : (
        <>
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
            {levels.length > 0 ? "+ level" : "+ sort"}
          </button>
          {levels.length > 0 && (
            <button className="ghost" onClick={() => applyLevels([])} title="Clear sort">
              Clear
            </button>
          )}
        </>
      )}

      {enableView && (
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
              <button
                className="icon-btn"
                onClick={() => (viewMode === "chips" ? setChipCols(chipCols - 1) : setColumns(columns - 1))}
                title="Fewer columns"
              >
                −
              </button>
              <span className="cols-n">{viewMode === "chips" ? chipCols : columns}</span>
              <button
                className="icon-btn"
                onClick={() => (viewMode === "chips" ? setChipCols(chipCols + 1) : setColumns(columns + 1))}
                title="More columns"
              >
                +
              </button>
            </span>
          )}
        </span>
      )}
    </div>
  );

  const toolbar = (
    <div className="sort-bar-shell">
      {isMobile && (
        <button
          className="sort-bar-toggle"
          onClick={() => setToolsOpen((o) => !o)}
          aria-expanded={toolsOpen}
        >
          <SlidersHorizontal size={14} />
          <span>Sort &amp; view</span>
          {toolsOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>
      )}
      {(!isMobile || toolsOpen) && sortBar}
    </div>
  );

  const renderList = (renderCard: (item: T, compact: boolean) => ReactNode): ReactNode => {
    const masonry = enableView && viewMode === "masonry";
    const chips = enableView && viewMode === "chips";
    if (manualMode) {
      return (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext
            items={sorted.map((it) => it.id)}
            strategy={masonry || chips ? rectSortingStrategy : verticalListSortingStrategy}
          >
            {chips ? (
              <div className="bv-chips" style={{ gridTemplateColumns: `repeat(${chipCols}, minmax(0, 1fr))` }}>
                {sorted.map((it) => (
                  <ManualChip key={it.id} item={it} type={it.blockTypeId ? typeById.get(it.blockTypeId) : undefined} />
                ))}
              </div>
            ) : masonry ? (
              <div className="masonry" style={{ columnCount: columns }}>
                {sorted.map((it) => (
                  <ManualMasonryItem key={it.id} id={it.id}>
                    {renderCard(it, true)}
                  </ManualMasonryItem>
                ))}
              </div>
            ) : (
              <div className="bv-manual-list">
                {sorted.map((it) => (
                  <ManualRow key={it.id} id={it.id}>
                    {renderCard(it, false)}
                  </ManualRow>
                ))}
              </div>
            )}
          </SortableContext>
        </DndContext>
      );
    }
    if (chips) {
      return (
        <div className="bv-chips" style={{ gridTemplateColumns: `repeat(${chipCols}, minmax(0, 1fr))` }}>
          {sorted.map((it) => (
            <BlockChip key={it.id} item={it} type={it.blockTypeId ? typeById.get(it.blockTypeId) : undefined} />
          ))}
        </div>
      );
    }
    if (!enableView || viewMode === "block") {
      return (
        <div className="block-stack">
          {sorted.map((it) => (
            <div key={it.id}>{renderCard(it, false)}</div>
          ))}
        </div>
      );
    }
    // Fixed column buckets (round-robin) instead of CSS column-count: a card
    // stays in its column when its height changes (e.g. collapse), rather than
    // the whole grid reflowing across columns.
    const buckets: T[][] = Array.from({ length: columns }, () => []);
    sorted.forEach((it, i) => buckets[i % columns]!.push(it));
    return (
      <div className="masonry-cols" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {buckets.map((col, ci) => (
          <div className="masonry-col" key={ci}>
            {col.map((it) => (
              <MasonryCard key={it.id} blockId={it.id} render={(compact) => renderCard(it, compact)} />
            ))}
          </div>
        ))}
      </div>
    );
  };

  return { sorted, active: sortActive, viewMode: enableView ? viewMode : "block", toolbar, renderList };
}
