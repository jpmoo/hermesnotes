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
import { ChevronDown, ChevronRight, GripVertical, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { BlockType } from "../api.ts";
import { oneLineText, rawOneLine } from "./display.ts";
import { MentionText } from "../components/MentionText.tsx";
import { isEditingTarget } from "./editing-target.ts";
import { fieldLabel, fieldText, parsePropKey, shownFields, type ShownField } from "./field-text.ts";
import { FieldChips } from "../components/FieldChips.tsx";
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

type SortKey = "alpha" | "created" | "edited" | "type" | `prop:${string}`;
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
  /** "" for one flat list, otherwise "type" or "prop:<key>". */
  groupBy?: string;
  /** Masonry and chip column counts — part of how the list looks, so they
   *  travel with the rest of it rather than staying on one browser. */
  columns?: number;
  chipCols?: number;
  /** Which group headings are shut, by group value. */
  groupsShut?: Record<string, boolean>;
  /** Whether this list's cards are collapsed — the caller owns the per-card
   *  state, but the intent belongs with the arrangement. */
  cardsCollapsed?: boolean;
}

const VIEW_KEY = "hn.blockview.mode";
const COLS_KEY = "hn.blockview.cols";
const CHIP_COLS_KEY = "hn.blockview.chipcols";
const GROUP_KEY = "hn.blockview.group";
const pretty = (k: string) => k.replace(/_/g, " ");

const readShut = (k: string): Record<string, boolean> => {
  try {
    const raw = localStorage.getItem(k);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === "object" ? (v as Record<string, boolean>) : {};
  } catch {
    return {};
  }
};
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

function valueFor(b: Viewable, key: SortKey, typeName?: (b: Viewable) => string): string {
  if (key === "alpha") return oneLineText(b.properties, b.content).toLowerCase();
  if (key === "created") return b.createdAt;
  if (key === "edited") return b.updatedAt;
  if (key === "type") return typeName?.(b) ?? "";
  // A span is two dates, and which one you mean depends on what you're doing —
  // when work can start, or when it's due. Same "prop:<key>.start/.end" spelling
  // the table's columns use.
  const raw = key.slice(5);
  const leg = raw.endsWith(".start") ? "start" : raw.endsWith(".end") ? "end" : null;
  const v = leg
    ? (b.properties[raw.slice(0, leg === "start" ? -6 : -4)] as { start?: unknown; end?: unknown } | null)?.[leg]
    : b.properties[raw];
  if (v == null) return "";
  // A sort saved before the two ends existed names the span itself; read it as
  // its start rather than as "[object Object]", which ordered nothing.
  if (typeof v === "object") return String((v as { start?: unknown }).start ?? "");
  return String(v);
}

/** A masonry card: compact preview. Clicking selects the block, whose full
 * editable card lives in the right panel — or opens it as a page on a phone,
 * where that panel is an off-screen drawer. */
function MasonryCard({ blockId, render }: { blockId: string; render: (compact: boolean) => ReactNode }) {
  const { selectOrOpen } = usePanels();
  return (
    <div
      className="masonry-item"
      data-block-id={blockId}
      onClick={(e) => {
        if (!isEditingTarget(e.target)) selectOrOpen(blockId);
      }}
    >
      {render(true)}
    </div>
  );
}

/** Constant-size chip: status/type icon + a slice of the title. Clicking selects
 * the block into the info panel — or opens it as a page on a phone; the status
 * glyph stays interactive. A div (not a button) so the status button isn't
 * nested inside another button. */
function BlockChip({
  item,
  type,
  grip,
  fields = [],
}: {
  item: Viewable;
  type: BlockType | undefined;
  grip?: ReactNode;
  fields?: ShownField[];
}) {
  const { selectOrOpen } = usePanels();
  const raw = rawOneLine(item.properties, item.content);
  const text = oneLineText(item.properties, item.content);
  return (
    <div
      className="bv-chip"
      data-block-id={item.id}
      role="button"
      tabIndex={0}
      title={text}
      onClick={(e) => {
        if (!isEditingTarget(e.target)) selectOrOpen(item.id);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          selectOrOpen(item.id);
        }
      }}
    >
      {grip}
      <StatusIcon block={item} type={type} size={15} className="bv-chip-status" />
      <span className="bv-chip-text">
        {raw ? <MentionText text={raw} /> : <span className="li-empty">Empty</span>}
      </span>
      <FieldChips fields={fields} properties={item.properties} compact />
    </div>
  );
}

/** A draggable chip in manual mode: grip first, then the chip body. */
function ManualChip({
  item,
  type,
  fields,
}: {
  item: Viewable;
  type: BlockType | undefined;
  fields: ShownField[];
}) {
  const s = useSortable({ id: item.id });
  const style = { transform: CSS.Translate.toString(s.transform), transition: s.transition };
  return (
    <div ref={s.setNodeRef} style={style} className="bv-chip-wrap">
      <BlockChip
        item={item}
        type={type}
        fields={fields}
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
  const { selectOrOpen } = usePanels();
  const style = { transform: CSS.Translate.toString(s.transform), transition: s.transition };
  return (
    <div
      ref={s.setNodeRef}
      style={style}
      className="masonry-item"
      onClick={(e) => {
        if (!isEditingTarget(e.target)) selectOrOpen(id);
      }}
    >
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
    /** Offer dragging into place. Off where the caller doesn't render the list
     *  itself (a rollup's headings), since there'd be nothing to drag. */
    enableManual?: boolean;
    /** Offer grouping. Off for the same reason: a caller that arranges the
     *  items itself never calls renderList, so the headings would never appear. */
    enableGroup?: boolean;
    scope?: string;
    manual?: { onMove: (activeId: string, overId: string) => void } | null;
    /** Inherit/persist sort + view selections (collection pages and embeds). */
    viewState?: { initial?: BlockViewState; onChange?: (vs: BlockViewState) => void };
  } = {},
): {
  sorted: T[];
  active: boolean;
  viewMode: ViewMode;
  /** The properties the list is sorted by — show them on the cards. */
  sortFields: ShownField[];
  toolbar: ReactNode;
  renderList: (renderCard: (item: T, compact: boolean) => ReactNode) => ReactNode;
} {
  const enableView = opts.enableView ?? true;
  const externalManual = opts.manual ?? null;
  // Manual is offered when the caller wires persistence (onMove) or names a
  // scope (localStorage-backed order).
  const manualAvailable =
    (opts.enableManual ?? true) && (Boolean(externalManual) || Boolean(opts.scope));
  const manualKey = opts.scope ? `hn.bv.manual.${opts.scope}` : "";
  const orderKey = opts.scope ? `hn.bv.order.${opts.scope}` : "";
  // View mode + column counts persist per scope (e.g. each type on the Types
  // page keeps its own), falling back to the shared key when no scope is given.
  const scopeSfx = opts.scope ? `.${opts.scope}` : "";
  const viewKey = VIEW_KEY + scopeSfx;
  const groupKey = GROUP_KEY + scopeSfx;
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
  const [groupBy, setGroupByState] = useState<string>(
    () => vs?.initial?.groupBy ?? readLS(groupKey) ?? "",
  );
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
    if (i.groupBy !== undefined) setGroupByState(i.groupBy);
    if (i.columns !== undefined) setColumnsState(clampCols(i.columns));
    if (i.chipCols !== undefined) setChipColsState(clampChipCols(i.chipCols));
    if (i.groupsShut !== undefined) setShut(i.groupsShut);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initKey]);

  /** Report a selection change to the persistence hook (fork or canonical). */
  const reportVS = (patch: BlockViewState) =>
    vs?.onChange?.({
      manual: manualMode0(),
      sort: levels,
      viewMode,
      groupBy,
      columns,
      chipCols,
      groupsShut: shut,
      cardsCollapsed: vs?.initial?.cardsCollapsed,
      ...patch,
    });
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
  const [columns, setColumnsState] = useState<number>(() =>
    clampCols(vs?.initial?.columns ?? Number(readLS(colsKey))),
  );
  // Chips are compact, so they take a wider range; the grid stretches them to
  // fill the content width whatever the panels leave available.
  const clampChipCols = (n: number) => Math.min(10, Math.max(1, n || 4));
  const [chipCols, setChipColsState] = useState<number>(() =>
    clampChipCols(vs?.initial?.chipCols ?? Number(readLS(chipColsKey))),
  );
  const setChipCols = (n: number) => {
    const c = clampChipCols(n);
    setChipColsState(c);
    writeLS(chipColsKey, String(c));
    reportVS({ chipCols: c });
  };
  // Re-read the device-appropriate column counts when crossing the breakpoint.
  useEffect(() => {
    setColumnsState(clampCols(Number(readLS(colsKey))));
    setChipColsState(clampChipCols(Number(readLS(chipColsKey))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile]);

  const setGroupBy = (g: string) => {
    setGroupByState(g);
    writeLS(groupKey, g);
    reportVS({ groupBy: g });
  };
  const setViewMode = (v: ViewMode) => {
    setViewModeState(v);
    writeLS(viewKey, v);
    reportVS({ viewMode: v });
  };
  const setColumns = (n: number) => {
    const c = clampCols(n);
    setColumnsState(c);
    writeLS(colsKey, String(c));
    reportVS({ columns: c });
  };
  const setManualMode = (on: boolean) => {
    setManualModeState(on);
    if (manualKey) writeLS(manualKey, on ? "1" : "0");
  };

  const fields = useMemo(() => commonFields(items, types), [items, types]);
  const typeById = useMemo(() => new Map(types.map((t) => [t.id, t])), [types]);
  const mixedTypes = useMemo(() => new Set(items.map((i) => i.blockTypeId)).size > 1, [items]);
  const typeName = (b: Viewable) =>
    (b.blockTypeId ? typeById.get(b.blockTypeId)?.name : "") ?? "";
  const options = useMemo(
    () => [
      { key: "alpha" as SortKey, label: "Alphabetical" },
      { key: "created" as SortKey, label: "Created" },
      { key: "edited" as SortKey, label: "Edited" },
      // Offered only where it would actually group anything — a list that's all
      // tasks has nothing to sort by type.
      ...(mixedTypes ? [{ key: "type" as SortKey, label: "Type" }] : []),
      ...fields.flatMap((f) => {
        const base = f.label?.trim() || pretty(f.key);
        // A whole span has no order of its own, so it offers its two ends
        // rather than itself.
        return f.type === "datespan"
          ? [
              {
                key: `prop:${f.key}.start` as SortKey,
                label: `${base} · ${f.startLabel?.trim() || "Start"}`,
              },
              {
                key: `prop:${f.key}.end` as SortKey,
                label: `${base} · ${f.endLabel?.trim() || "End"}`,
              },
            ]
          : [{ key: `prop:${f.key}` as SortKey, label: base }];
      }),
    ],
    [fields, mixedTypes],
  );

  // Any property can head a group, a span by either of its ends — the same
  // list the sort offers.
  const groupOptions = useMemo(() => {
    const out: { key: string; label: string }[] = [];
    if (mixedTypes) out.push({ key: "type", label: "Type" });
    for (const f of fields) {
      // An attachment list is a file store: no value to head a group with.
      if (f.type === "attachments") continue;
      if (f.type === "datespan") {
        out.push({ key: `prop:${f.key}.start`, label: fieldLabel(f, "start") });
        out.push({ key: `prop:${f.key}.end`, label: fieldLabel(f, "end") });
      } else {
        out.push({ key: `prop:${f.key}`, label: fieldLabel(f) });
      }
    }
    return out;
  }, [fields, mixedTypes]);
  const groupsOffered = opts.enableGroup ?? true;
  const groupProp = groupBy.startsWith("prop:") ? parsePropKey(groupBy.slice(5)) : null;
  const groupField = groupProp ? fields.find((f) => f.key === groupProp.key) : undefined;
  // Dropping the field a list was grouped by (a type edited elsewhere) leaves
  // the selection naming nothing: fall back to one flat list rather than to a
  // single group called "None".
  const grouping = !groupsOffered ? "" : groupBy === "type" ? "type" : groupField ? "prop" : "";

  // Which group headings are shut, by group value. Shut rather than open, so a
  // heading nobody has touched starts open. Part of the arrangement, so it
  // travels with it — and falls back to this browser for lists that keep no
  // arrangement of their own.
  const openKey = `hn.bv.groups.${opts.scope ?? "x"}`;
  const [shut, setShut] = useState<Record<string, boolean>>(
    () => vs?.initial?.groupsShut ?? readShut(openKey),
  );
  const openGroups = {
    isOpen: (k: string) => !shut[k],
    toggle: (k: string) => {
      const next = { ...shut, [k]: !shut[k] };
      setShut(next);
      writeLS(openKey, JSON.stringify(next));
      reportVS({ groupsShut: next });
    },
  };

  const sortActive = !manualMode && levels.length > 0;
  // What the list is ordered by, so it can be shown on whatever the list draws.
  // Sorting by something invisible is a list in an order you can't account for.
  const sortFields = useMemo(
    () => (manualMode ? [] : shownFields(levels, fields)),
    [levels, fields, manualMode],
  );
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
        const va = valueFor(a, lv.key, typeName);
        const vb = valueFor(b, lv.key, typeName);
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
  }, [items, levels, manualMode, externalManual, localOrder, typeById]);

  /**
   * The sorted list cut into groups. Order follows the field where it declares
   * one — a status's own options, so a board reads Backlog → Doing → Done
   * rather than alphabetically — and the blanks come first: what nobody has
   * filled in yet is usually the pile you're looking for, not the one to scroll
   * past everything else to reach.
   */
  const groups = useMemo(() => {
    if (!grouping || manualMode) return null;
    const of = (it: T): { key: string; label: string } => {
      if (grouping === "type") {
        const name = typeName(it);
        return { key: name, label: name || "No type" };
      }
      const f = groupField!;
      const stored = it.properties[f.key];
      const part = groupProp?.part;
      const raw = part ? (stored as { start?: unknown; end?: unknown } | null)?.[part] : stored;
      const key = raw == null || raw === "" ? "" : String(raw);
      return {
        key,
        label: key === "" ? `No ${fieldLabel(f, part)}` : fieldText(f, stored, part) || key,
      };
    };
    const byKey = new Map<string, { key: string; label: string; items: T[] }>();
    for (const it of sorted) {
      const g = of(it);
      const bucket = byKey.get(g.key) ?? { ...g, items: [] };
      bucket.items.push(it);
      byKey.set(g.key, bucket);
    }
    const declared = groupField?.options ?? null;
    const rank = (k: string) => {
      if (k === "") return -1; // blanks first
      const i = declared?.indexOf(k) ?? -1;
      return i >= 0 ? i : Number.MAX_SAFE_INTEGER;
    };
    return [...byKey.values()].sort((a, b) => {
      const r = rank(a.key) - rank(b.key);
      return r !== 0 ? r : a.label.localeCompare(b.label);
    });
  }, [grouping, groupField, groupProp?.part, manualMode, sorted, typeById]);

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

  // Grouping decides the headings and sorting the order within them: two
  // questions, but small ones, and a line each left more empty bar than
  // controls. Grouping leads, then a rule, then the sort.
  const groupCtl = !manualMode && groupsOffered && groupOptions.length > 0 && (
    <>
      <span className="sort-label">group</span>
      <span className="sort-level">
        <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
          <option value="">None</option>
          {groupOptions.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
      </span>
      <span className="sort-sep" />
    </>
  );

  const sortBar = (
    <div className="sort-bar">
      {groupCtl}
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
          {toolsOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
      )}
      {(!isMobile || toolsOpen) && sortBar}
    </div>
  );

  const renderList = (renderCard: (item: T, compact: boolean) => ReactNode): ReactNode => {
    if (groups) {
      return (
        <div className="bv-groups">
          {groups.map((g) => (
            <section className="bv-group" key={`g:${g.key}`}>
              <header className="bv-group-head">
                <button
                  className="icon-btn ru-twist"
                  title={openGroups.isOpen(g.key) ? "Collapse" : "Expand"}
                  onClick={() => openGroups.toggle(g.key)}
                >
                  {openGroups.isOpen(g.key) ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                </button>
                <span className="bv-group-label">{g.label}</span>
                <span className="ru-count">{g.items.length}</span>
              </header>
              {openGroups.isOpen(g.key) && <div className="bv-group-body">{renderItems(g.items, renderCard)}</div>}
            </section>
          ))}
        </div>
      );
    }
    return renderItems(sorted, renderCard);
  };

  const renderItems = (
    list: T[],
    renderCard: (item: T, compact: boolean) => ReactNode,
  ): ReactNode => {
    const sorted = list; // the group's slice, or the whole list
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
                  <ManualChip
                    key={it.id}
                    item={it}
                    type={it.blockTypeId ? typeById.get(it.blockTypeId) : undefined}
                    fields={sortFields}
                  />
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
            <BlockChip
              key={it.id}
              item={it}
              type={it.blockTypeId ? typeById.get(it.blockTypeId) : undefined}
              fields={sortFields}
            />
          ))}
        </div>
      );
    }
    if (!enableView || viewMode === "block") {
      return (
        <div className="block-stack">
          {sorted.map((it) => (
            <div key={it.id} data-block-id={it.id}>{renderCard(it, false)}</div>
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

  return {
    sorted,
    active: sortActive,
    viewMode: enableView ? viewMode : "block",
    sortFields,
    toolbar,
    renderList,
  };
}
