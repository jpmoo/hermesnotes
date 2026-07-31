import {
  closestCenter,
  DndContext,
  DragOverlay,
  MouseSensor,
  pointerWithin,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type { FieldDef, PropertySchema } from "@hermes/shared";
import { ChevronDown, ChevronUp, Settings2, X } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api, type Block, type BlockType, type Collection, type Member } from "../api.ts";
import { useAnyBlockChange } from "../lib/block-events.ts";
import { isOverdue, oneLineText } from "../lib/display.ts";
import { MentionText } from "./MentionText.tsx";
import { normalizeFilter } from "../lib/filter.ts";
import { BlockIcon } from "../lib/icons.tsx";
import { usePanels } from "../lib/right-panel.tsx";
import { ColorPickerModal } from "./ColorPickerModal.tsx";
import { DateTimePicker } from "./DateTimePicker.tsx";

type RegionSize = "short" | "medium" | "tall";
const REGION_HEIGHTS: Record<RegionSize, number> = { short: 224, medium: 280, tall: 350 };
const regionHeight = (size?: string): number =>
  REGION_HEIGHTS[(size as RegionSize) in REGION_HEIGHTS ? (size as RegionSize) : "medium"];

/** A readable text color for a region's background: light on dark, dark on light. */
function readableOn(bg: string | null): string | undefined {
  if (!bg) return undefined;
  const h = bg.trim().replace(/^#/, "");
  const hex = h.length === 3 ? h.replace(/(.)/g, "$1$1") : h;
  if (!/^[0-9a-f]{6}$/i.test(hex)) return undefined;
  const n = parseInt(hex, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum < 0.55 ? "#f4f5f6" : "#1f2328";
}

// Pointer-based collision so the droppable UNDER the cursor wins (reliable
// reordering even when a big chip overlaps several drop zones); falls back to
// nearest-center when the pointer is outside every droppable.
const matrixCollision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  if (!hits.length) return closestCenter(args);
  // A card (chip:) and its region both contain the pointer — prefer the card so
  // dropping onto it reorders, rather than falling back to region placement.
  const chip = hits.find((h) => String(h.id).startsWith("chip:"));
  return chip ? [chip] : hits;
};

interface RegionDef {
  title: string;
  color: string | null;
  // Fixed rendered height (renders full even when not filled; content scrolls).
  size?: RegionSize;
  // Region actions (custom grids): tag added on enter / removed on leave, and
  // a status applied to the card's own status field on enter.
  tag?: string;
  tagOnEnter?: boolean;
  tagOffLeave?: boolean;
  enterStatus?: string;
}

interface Item {
  id: string;
  blockTypeId: string | null;
  label: string;
  /** The title as stored, mentions intact. The flattened form stays in label,
   *  for tooltips and anything comparing text. */
  rawLabel: string;
  member: boolean; // an explicit membership (vs a drawer candidate / bound match)
  props?: Record<string, unknown>;
  version?: number;
}

const REGION_MAX = 6;
const DAYS_MAX = 7;
const pretty = (v: string) => v.replace(/_/g, " ");

// Date-bound region modes: columns are consecutive days.
const DATE_KEYS = ["@days_before", "@days_after", "@days_around", "@days_span"] as const;
const SPAN_MAX = 31; // day-column cap for a custom range
const pad2 = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** The visible day columns (YYYY-MM-DD) for a date mode. All include today. */
function dayList(mode: string, count: number): string[] {
  const n = Math.min(DAYS_MAX, Math.max(1, count));
  let startOffset = 0;
  if (mode === "@days_before") startOffset = -(n - 1);
  else if (mode === "@days_around") startOffset = -Math.floor((n - 1) / 2);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() + startOffset + i);
    return ymd(d);
  });
}

/** Day columns for an explicit start..end range (capped at SPAN_MAX). */
function daySpan(start: string, end: string): string[] {
  const ok = (v: string) => /^\d{4}-\d{2}-\d{2}/.test(v);
  const st = ok(start) ? start.slice(0, 10) : "";
  const en = ok(end) ? end.slice(0, 10) : "";
  if (!st || !en || en < st) return [st || en || ymd(new Date())];
  const out: string[] = [];
  const d = new Date(`${st}T00:00`);
  for (let i = 0; i < SPAN_MAX; i++) {
    const k = ymd(d);
    out.push(k);
    if (k === en) break;
    d.setDate(d.getDate() + 1);
  }
  return out;
}

const fmtDayHead = (date: string) =>
  new Date(`${date}T00:00`).toLocaleDateString(undefined, { weekday: "short", month: "numeric", day: "numeric" });

/** Column indexes a block occupies: any date/datetime lands on its day; a
 * datespan covers every visible day it overlaps. */
function dayIndexes(schema: PropertySchema | null | undefined, props: Record<string, unknown>, days: string[]): Set<number> {
  const out = new Set<number>();
  const hit = (day: string) => {
    const i = days.indexOf(day);
    if (i >= 0) out.add(i);
  };
  for (const f of schema?.fields ?? []) {
    const v = props[f.key];
    if (v == null || v === "") continue;
    if (f.type === "datetime" || f.type === "date") hit(String(v).slice(0, 10));
    else if (f.type === "datespan" && typeof v === "object") {
      const span = v as { start?: string; end?: string };
      const s = span.start?.slice(0, 10) || "";
      const e = span.end?.slice(0, 10) || "";
      if (s && e) {
        for (let i = 0; i < days.length; i++) if (days[i]! >= s && days[i]! <= e) out.add(i);
      } else if (s || e) hit(s || e);
    }
  }
  return out;
}

function readRegions(props: Record<string, unknown>, count: number, key = "matrix_regions"): RegionDef[] {
  const raw = Array.isArray(props[key]) ? (props[key] as RegionDef[]) : [];
  return Array.from({ length: count }, (_, i) => ({
    ...raw[i],
    title: String(raw[i]?.title ?? ""),
    color: (raw[i]?.color as string | null) ?? null,
  }));
}

const hasActions = (def: RegionDef | undefined) => Boolean(def && (def.tag || def.enterStatus));

const fmtShort = (v: string) => {
  const d = new Date(v.includes("T") ? v : `${v}T00:00`);
  return Number.isNaN(d.getTime())
    ? v
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

interface DateBit {
  text: string;
  overdue: boolean;
}

/** Short display strings for any dated fields on the block. A datespan's due
 * (end) date in the past marks the bit overdue — unless the block is complete. */
function dateBits(schema: PropertySchema | null | undefined, props: Record<string, unknown>): DateBit[] {
  const statusKey = schema?.status_field;
  // Only status-bearing (task-like) blocks can be "overdue" — an event's end
  // date just passes, it isn't overdue.
  const done = statusKey
    ? (schema?.complete_values ?? []).includes(String(props[statusKey] ?? ""))
    : false;
  const overdueEligible = Boolean(statusKey) && !done;
  const out: DateBit[] = [];
  for (const f of schema?.fields ?? []) {
    const v = props[f.key];
    if (v == null || v === "") continue;
    if (f.type === "datetime" || f.type === "date") {
      out.push({ text: fmtShort(String(v)), overdue: false });
    } else if (f.type === "datespan" && typeof v === "object") {
      const span = v as { start?: string; end?: string };
      const s = span.start ? fmtShort(span.start) : "";
      const e = span.end ? fmtShort(span.end) : "";
      if (s || e) {
        out.push({
          text: s && e ? `${s} – ${e}` : s || e,
          overdue: overdueEligible && isOverdue(span.end),
        });
      }
    }
  }
  return out;
}

// Types are shared across many chips; a tiny module-level store avoids prop
// threading through dnd wrappers.
let typesStore: BlockType[] = [];
const typesSubs = new Set<() => void>();
function useMatrixTypes() {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    typesSubs.add(f);
    return () => void typesSubs.delete(f);
  }, []);
  return { types: typesStore };
}

// Chip hover tooltip. Native `title` is unreliable on the dnd-kit drag handles,
// so a single portal'd bubble is driven from a module-level store the same way.
let tipStore: { text: string; x: number; y: number } | null = null;
const tipSubs = new Set<() => void>();
function setTip(next: typeof tipStore): void {
  tipStore = next;
  for (const f of [...tipSubs]) f();
}
function MatrixTooltip() {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    tipSubs.add(f);
    return () => void tipSubs.delete(f);
  }, []);
  if (!tipStore) return null;
  // Offset from the cursor; flip left/up near the viewport edges.
  const flipX = tipStore.x > window.innerWidth - 260;
  const flipY = tipStore.y > window.innerHeight - 60;
  const style: CSSProperties = {
    position: "fixed",
    left: flipX ? undefined : tipStore.x + 14,
    right: flipX ? window.innerWidth - tipStore.x + 14 : undefined,
    top: flipY ? undefined : tipStore.y + 18,
    bottom: flipY ? window.innerHeight - tipStore.y + 18 : undefined,
  };
  return createPortal(
    <div className="matrix-tip" style={style}>
      {tipStore.text}
    </div>,
    document.body,
  );
}

function statusFieldOf(type: BlockType | undefined): FieldDef | null {
  const schema = type?.propertySchema;
  const key = schema?.status_field;
  return schema?.fields.find((f) => f.type === "status" && f.key === key) ?? null;
}

/** The stored title, mentions and all; falls back to the flattened one-liner
 *  when a card has no title (a note's first sentence, say). */
function rawTitle(properties: Record<string, unknown> | null | undefined, content?: string | null): string {
  const title = properties?.title;
  return typeof title === "string" && title.trim() ? title.trim() : oneLineText(properties, content) || "Untitled";
}

/** One draggable chip: status (interactive), label, dates, remove. */
function Chip({
  item,
  onRemove,
  onStatus,
}: {
  item: Item;
  onRemove?: (id: string) => void;
  onStatus?: (item: Item, field: FieldDef, next: string) => void;
}) {
  const { selectBlock, selectOrOpen } = usePanels();
  const { types } = useMatrixTypes();
  const drag = useDraggable({
    id: `${item.member ? "m" : "c"}:${item.id}`,
    data: item as unknown as Record<string, unknown>,
  });
  // Also a drop target, so dragging a card onto another reorders it there. The
  // card's own drop zone is disabled while it's the one being dragged, so it
  // can't target itself (which would cancel the reorder).
  const chipDrop = useDroppable({
    id: `chip:${item.id}`,
    disabled: drag.isDragging,
    data: item as unknown as Record<string, unknown>,
  });
  const setRef = (el: HTMLElement | null) => {
    drag.setNodeRef(el);
    chipDrop.setNodeRef(el);
  };
  const t = item.blockTypeId ? types.find((x) => x.id === item.blockTypeId) : undefined;
  const statusField = item.props && onStatus ? statusFieldOf(t) : null;
  const status = statusField ? String(item.props?.[statusField.key] ?? "") : "";
  const dates = item.props ? dateBits(t?.propertySchema ?? null, item.props) : [];

  const cycle = () => {
    if (!statusField || !onStatus) return;
    const opts = statusField.options ?? [];
    if (!opts.length) return;
    const next = opts[(opts.indexOf(status) + 1) % opts.length];
    if (next) onStatus(item, statusField, next);
  };

  const tipTimer = useRef<ReturnType<typeof setTimeout>>();
  const armTip = (e: React.MouseEvent) => {
    const { clientX, clientY } = e;
    clearTimeout(tipTimer.current);
    tipTimer.current = setTimeout(() => setTip({ text: item.label, x: clientX, y: clientY }), 350);
  };
  const clearTip = () => {
    clearTimeout(tipTimer.current);
    setTip(null);
  };
  useEffect(() => () => clearTimeout(tipTimer.current), []);

  return (
    <div
      ref={setRef}
      {...drag.attributes}
      {...drag.listeners}
      className={`matrix-chip${drag.isDragging ? " dragging" : ""}${chipDrop.isOver ? " chip-over" : ""}`}
      data-block-id={item.id}
      onMouseEnter={armTip}
      onMouseLeave={clearTip}
      onClick={(e) => {
        e.stopPropagation();
        clearTip();
        selectOrOpen(item.id);
      }}
    >
      <div className="chip-row">
        {statusField ? (
          <button
            className="chip-status"
            title={status ? `Status: ${pretty(status)} — click to cycle` : "Set status"}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              cycle();
            }}
          >
            <BlockIcon
              iconKey={statusField.optionIcons?.[status] || t?.iconKey}
              color={statusField.optionColors?.[status] || t?.iconColor}
              size={15}
            />
          </button>
        ) : (
          <BlockIcon
            iconKey={!t || t.isText ? "type" : t.iconKey}
            color={t && !t.isText ? t.iconColor : null}
            size={14}
          />
        )}
        <span className="chip-label"><MentionText text={item.rawLabel} /></span>
        {dates.length > 0 && (
          <span className="chip-dates">
            {dates.map((d, i) =>
              d.overdue ? (
                <span key={i} className="overdue-pill">
                  {d.text}
                </span>
              ) : (
                <span key={i}>{d.text}</span>
              ),
            )}
          </span>
        )}
        {onRemove && (
          <button
            className="icon-btn chip-remove"
            title="Put in drawer"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onRemove(item.id);
            }}
          >
            <X size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

function ChipGhost({ item }: { item: Item }) {
  const { types } = useMatrixTypes();
  const t = item.blockTypeId ? types.find((x) => x.id === item.blockTypeId) : undefined;
  return (
    <>
      <BlockIcon
        iconKey={!t || t.isText ? "type" : t.iconKey}
        color={t && !t.isText ? t.iconColor : null}
        size={14}
      />
      <span className="chip-label"><MentionText text={item.rawLabel} /></span>
    </>
  );
}

function RegionCell({
  index,
  title,
  color,
  size,
  editable,
  items,
  onTitle,
  onColor,
  onActions,
  actionsSet = false,
  onRemove,
  onStatus,
  onInteract,
}: {
  index: number;
  title: string;
  color: string | null;
  size?: RegionSize;
  editable: boolean;
  items: Item[];
  onTitle?: (index: number, title: string) => void;
  onColor?: (index: number) => void;
  onActions?: (index: number) => void;
  actionsSet?: boolean;
  onRemove?: (id: string) => void;
  onStatus?: (item: Item, field: FieldDef, next: string) => void;
  onInteract?: () => void;
}) {
  const drop = useDroppable({ id: `r:${index}` });
  return (
    <div
      ref={drop.setNodeRef}
      className={`matrix-region${drop.isOver ? " over" : ""}${color ? " colored" : ""}`}
      style={{ height: regionHeight(size), ...(color ? { background: color, borderColor: color, color: readableOn(color) } : {}) }}
      onClick={onInteract}
    >
      <div className="region-head">
        {editable && (
          <button
            className="region-color"
            title="Region color"
            style={{ background: color ?? "var(--border-strong)" }}
            onClick={(e) => {
              e.stopPropagation();
              onInteract?.();
              onColor?.(index);
            }}
          />
        )}
        {editable ? (
          <input
            className="region-title"
            placeholder="Untitled region"
            value={title}
            onFocus={onInteract}
            onChange={(e) => onTitle?.(index, e.target.value)}
          />
        ) : (
          <span className="region-title-static">{pretty(title) || "—"}</span>
        )}
        {editable && (
          <button
            className={`icon-btn region-actions${actionsSet ? " set" : ""}`}
            title={actionsSet ? "Region actions (configured)" : "Region actions"}
            onClick={(e) => {
              e.stopPropagation();
              onInteract?.();
              onActions?.(index);
            }}
          >
            <Settings2 size={13} />
          </button>
        )}
        <span className="region-count">{items.length || ""}</span>
      </div>
      <div className="region-body">
        {items.map((it) => (
          <Chip key={it.id} item={it} onRemove={onRemove} onStatus={onStatus} />
        ))}
      </div>
    </div>
  );
}

/** Date mode: the full-width droppable band behind one row-region. */
function RowBand({
  index,
  color,
  rowStart,
  rowSpan,
}: {
  index: number;
  color: string | null;
  rowStart: number;
  rowSpan: number;
}) {
  const drop = useDroppable({ id: `row:${index}` });
  return (
    <div
      ref={drop.setNodeRef}
      className={`row-band${drop.isOver ? " over" : ""}${color ? " colored" : ""}`}
      style={{
        gridColumn: "1 / -1",
        gridRow: `${rowStart} / ${rowStart + rowSpan}`,
        ...(color ? { background: color } : {}),
      }}
    />
  );
}

/**
 * Matrix collection: an x/y grid of titled, colored regions. Members are placed
 * by dragging from the bottom drawer into a region (context.region). A smart
 * matrix can instead BIND its regions to a status property: regions take the
 * option names/colors, query matches auto-place by value, and dragging a card
 * into a region (or cycling its status) sets that property.
 */
export function MatrixView({
  collection,
  members,
  types,
  onChanged,
  header,
}: {
  collection: Collection;
  members: Member[];
  types: BlockType[];
  onChanged: () => void;
  /** Extra controls (e.g. the Smart pill + refresh) shown inline in the dims row. */
  header?: ReactNode;
}) {
  typesStore = types;
  typesSubs.forEach((f) => f());

  const { selectBlock, selectOrOpen, refreshInfo, bottomSlotEl, selectedBlockId } = usePanels();
  // Collection-level interactions make the collection the active block (so its
  // query tools show); card interactions make the card active instead.
  const selectCollection = () => selectBlock(collection.id, { collection: true });

  const props = collection.properties;
  const isSmart = props.membership_mode === "smart";
  const bindKey = typeof props.matrix_bind_property === "string" ? props.matrix_bind_property : "";
  const dateMode = isSmart && (DATE_KEYS as readonly string[]).includes(bindKey);
  const bound = isSmart && !!bindKey && !dateMode; // status-bound
  const dayCount = Math.min(DAYS_MAX, Math.max(1, Number(props.matrix_bind_count) || 3));
  const spanStart = typeof props.matrix_date_start === "string" ? props.matrix_date_start : "";
  const spanEnd = typeof props.matrix_date_end === "string" ? props.matrix_date_end : "";
  const days = useMemo(
    () =>
      dateMode
        ? bindKey === "@days_span"
          ? daySpan(spanStart, spanEnd)
          : dayList(bindKey, dayCount)
        : [],
    [dateMode, bindKey, dayCount, spanStart, spanEnd],
  );
  const lanesMap = useMemo(
    () => (props.matrix_lanes && typeof props.matrix_lanes === "object" ? (props.matrix_lanes as Record<string, number>) : {}),
    [props.matrix_lanes],
  );

  const cols = Math.min(REGION_MAX, Math.max(1, Number(props.matrix_cols) || 2));
  const rows = Math.min(REGION_MAX, Math.max(1, Number(props.matrix_rows) || 2));
  // Date mode swaps the region axis: day columns × row-regions. Rows have their
  // own defs (matrix_date_rows) so the custom grid's regions stay untouched.
  const dRows = Math.min(REGION_MAX, Math.max(1, Number(props.matrix_date_row_count) || 1));
  const regionsKey = dateMode ? "matrix_date_rows" : "matrix_regions";
  const count = dateMode ? dRows : cols * rows;

  const [regions, setRegions] = useState<RegionDef[]>(() => readRegions(props, count, regionsKey));
  const [colorEdit, setColorEdit] = useState<number | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [q, setQ] = useState("");
  const [candidates, setCandidates] = useState<Item[]>([]);
  const [matches, setMatches] = useState<Block[]>([]); // smart: full query matches
  const [queryTick, setQueryTick] = useState(0); // bump to re-run the query
  // A block edited anywhere (e.g. the info pane) may fall in/out of the query,
  // so re-run it — this is what drops a completed task's chip without a reload.
  useAnyBlockChange(() => {
    if (isSmart) setQueryTick((t) => t + 1);
  });
  const [active, setActive] = useState<Item | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    setRegions(readRegions(collection.properties, count, regionsKey));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collection, count, regionsKey]);

  // Mouse drags on a small move; touch needs a short press-and-hold so a quick
  // swipe still scrolls the drawer/regions (the old lone PointerSensor never
  // activated on touch — the browser scrolled before the 5px threshold).
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
  );

  // Status-type fields available for binding (union across types, by key).
  const bindable = useMemo(() => {
    const seen = new Map<string, string>();
    for (const t of types) {
      for (const f of t.propertySchema?.fields ?? []) {
        if (f.type === "status" && !seen.has(f.key)) seen.set(f.key, f.label?.trim() || pretty(f.key));
      }
    }
    return [...seen.entries()].map(([key, label]) => ({ key, label }));
  }, [types]);

  // The bound field's option list (+colors) — from the first type that has it.
  const boundField = useMemo(() => {
    if (!bound) return null;
    for (const t of types) {
      const f = t.propertySchema?.fields.find((x) => x.type === "status" && x.key === bindKey);
      if (f) return f;
    }
    return null;
  }, [bound, bindKey, types]);
  const boundOptions = (boundField?.options ?? []).slice(0, REGION_MAX);

  // Smart matrices fetch the live match set: bound/date modes place from it,
  // and unbound ones use it to hide placed members the query no longer matches
  // (e.g. tasks completed from a chip).
  useEffect(() => {
    if (!isSmart) return;
    let alive = true;
    void api
      .post<Block[]>("/blocks/query", { filterQuery: normalizeFilter(props.filter_query) })
      .then((r) => {
        if (alive) setMatches(r);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSmart, JSON.stringify(props.filter_query), collection.updatedAt, queryTick]);

  const memberIds = useMemo(() => new Set(members.map((m) => m.id)), [members]);
  const matchIds = useMemo(() => new Set(matches.map((b) => b.id)), [matches]);

  const toItem = (m: Member): Item => ({
    id: m.id,
    blockTypeId: m.blockTypeId,
    label: oneLineText(m.properties, m.content) || "Untitled",
    rawLabel: rawTitle(m.properties, m.content),
    member: true,
    props: m.properties,
    version: m.version,
  });
  const blockToItem = (b: Block): Item => ({
    id: b.id,
    blockTypeId: b.blockTypeId,
    label: oneLineText(b.properties, b.content) || "Untitled",
    rawLabel: rawTitle(b.properties, b.content),
    member: false,
    props: b.properties,
    version: b.version,
  });

  // Placement: bound → by property value; unbound → context.region.
  const placement = useMemo(() => {
    const map = new Map<number, Item[]>();
    const loose: Item[] = [];
    if (bound) {
      for (const b of matches) {
        const v = String((b.properties as Record<string, unknown>)?.[bindKey] ?? "");
        const idx = boundOptions.indexOf(v);
        if (idx >= 0) map.set(idx, [...(map.get(idx) ?? []), blockToItem(b)]);
        else loose.push(blockToItem(b));
      }
    } else {
      for (const m of members) {
        // Smart: a placed member the query no longer matches is hidden (its
        // membership stays, so it reappears in place if it matches again).
        if (isSmart && !matchIds.has(m.id)) continue;
        const item = toItem(m);
        const r = Number((m.context as Record<string, unknown>)?.region);
        if (Number.isInteger(r) && r >= 0 && r < count) map.set(r, [...(map.get(r) ?? []), item]);
        else loose.push(item);
      }
    }
    return { map, loose };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bound, isSmart, matches, matchIds, members, count, bindKey, boundOptions.join("|")]);

  // Drawer candidates (unbound only): smart → query matches (fetched eagerly so
  // the closed drawer can show its count); manual → search once opened.
  useEffect(() => {
    if (bound || dateMode) return;
    if (!isSmart && !drawerOpen) return;
    let alive = true;
    const t = setTimeout(async () => {
      try {
        let found: Item[] = [];
        if (isSmart) {
          const res = await api.post<{ blocks: { id: string; blockTypeId: string | null; label: string }[] }>(
            "/collections/query-preview",
            { filterQuery: normalizeFilter(props.filter_query) },
          );
          found = res.blocks.map((b) => ({ ...b, member: false, rawLabel: b.label }));
        } else {
          const res = await api.get<{ id: string; blockTypeId: string | null; label: string }[]>(
            `/blocks/search?q=${encodeURIComponent(q)}`,
          );
          found = res.map((b) => ({ ...b, member: false, rawLabel: b.label }));
        }
        if (alive) setCandidates(found.filter((b) => !memberIds.has(b.id)));
      } catch {
        if (alive) setCandidates([]);
      }
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [drawerOpen, q, isSmart, bound, memberIds, props.filter_query]);

  /** Date mode: the row-region a card sits in (matrix_lanes, clamped). */
  const rowOfCard = (id: string): number => {
    const r = Number(lanesMap[id]);
    return Number.isInteger(r) && r >= 0 && r < dRows ? r : 0;
  };

  // Date mode: contiguous day-runs per block ("bars"). Each card belongs to a
  // row-region (rowOfCard); within a row, bars pack into the first sub-lane
  // where they don't overlap, so a card's bars stay aligned across columns.
  const dateData = useMemo(() => {
    if (!dateMode)
      return {
        bars: [] as { item: Item; start: number; end: number; row: number; sub: number }[],
        loose: [] as Item[],
        subCounts: [] as number[],
      };
    const typeById = new Map(types.map((t) => [t.id, t]));
    const withRuns: { item: Item; runs: [number, number][]; firstDay: number }[] = [];
    const loose: Item[] = [];
    for (const b of matches) {
      const t = b.blockTypeId ? typeById.get(b.blockTypeId) : undefined;
      const idxs = [...dayIndexes(t?.propertySchema ?? null, b.properties as Record<string, unknown>, days)].sort((a, z) => a - z);
      if (!idxs.length) {
        loose.push(blockToItem(b));
        continue;
      }
      const runs: [number, number][] = [];
      let start = idxs[0]!;
      let prev = idxs[0]!;
      for (const i of idxs.slice(1)) {
        if (i === prev + 1) prev = i;
        else {
          runs.push([start, prev]);
          start = i;
          prev = i;
        }
      }
      runs.push([start, prev]);
      withRuns.push({ item: blockToItem(b), runs, firstDay: idxs[0]! });
    }
    withRuns.sort((a, z) => a.firstDay - z.firstDay || a.item.label.localeCompare(z.item.label));
    const subSpans: [number, number][][][] = Array.from({ length: dRows }, () => []);
    const overlaps = (row: number, sub: number, runs: [number, number][]) =>
      (subSpans[row]![sub] ?? []).some(([s1, e1]) => runs.some(([s2, e2]) => s1 <= e2 && s2 <= e1));
    const bars: { item: Item; start: number; end: number; row: number; sub: number }[] = [];
    for (const bw of withRuns) {
      const row = rowOfCard(bw.item.id);
      let sub = 0;
      while (overlaps(row, sub, bw.runs)) sub++;
      subSpans[row]![sub] = [...(subSpans[row]![sub] ?? []), ...bw.runs];
      for (const [rs, re] of bw.runs) bars.push({ item: bw.item, start: rs, end: re, row, sub });
    }
    const subCounts = subSpans.map((x) => Math.max(1, x.length));
    return { bars, loose, subCounts };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateMode, matches, days, types, lanesMap, dRows]);

  // Grid-row of a row-region's header line (row 1 holds the day heads).
  const rowStartOf = (r: number) =>
    2 + dateData.subCounts.slice(0, r).reduce((a, b) => a + 1 + b, 0);
  const rowCounts = useMemo(() => {
    const c = new Map<number, Set<string>>();
    for (const b of dateData.bars) {
      if (!c.has(b.row)) c.set(b.row, new Set());
      c.get(b.row)!.add(b.item.id);
    }
    return c;
  }, [dateData]);

  // Editable axis labels (custom/status grids).
  const [axisX, setAxisX] = useState(String(props.matrix_x_label ?? ""));
  const [axisY, setAxisY] = useState(String(props.matrix_y_label ?? ""));
  useEffect(() => {
    setAxisX(String(collection.properties.matrix_x_label ?? ""));
    setAxisY(String(collection.properties.matrix_y_label ?? ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collection]);
  const axisTimers = useRef<{ x?: ReturnType<typeof setTimeout>; y?: ReturnType<typeof setTimeout> }>({});
  const saveAxis = (axis: "x" | "y", v: string) => {
    (axis === "x" ? setAxisX : setAxisY)(v);
    const key = axis === "x" ? "matrix_x_label" : "matrix_y_label";
    if (axisTimers.current[axis]) clearTimeout(axisTimers.current[axis]);
    axisTimers.current[axis] = setTimeout(
      () => void api.patch(`/collections/${collection.id}`, { [key]: v }),
      600,
    );
  };

  const saveRegions = (next: RegionDef[]) => {
    setRegions(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(
      () => void api.patch(`/collections/${collection.id}`, { [regionsKey]: next }),
      600,
    );
  };
  const onTitle = (i: number, title: string) =>
    saveRegions(regions.map((r, idx) => (idx === i ? { ...r, title } : r)));
  const onColorSave = (color: string) => {
    if (colorEdit == null) return;
    const next = regions.map((r, idx) => (idx === colorEdit ? { ...r, color } : r));
    setColorEdit(null);
    setRegions(next);
    void api.patch(`/collections/${collection.id}`, { [regionsKey]: next });
  };

  const resize = (nextCols: number, nextRows: number) => {
    selectCollection();
    const c = Math.min(REGION_MAX, Math.max(1, nextCols));
    const r = Math.min(REGION_MAX, Math.max(1, nextRows));
    const n = readRegions({ ...props, matrix_regions: regions }, c * r);
    void api
      .patch(`/collections/${collection.id}`, { matrix_cols: c, matrix_rows: r, matrix_regions: n })
      .then(onChanged);
  };

  const resizeDateRows = (nextRows: number) => {
    selectCollection();
    const r = Math.min(REGION_MAX, Math.max(1, nextRows));
    const n = readRegions({ matrix_date_rows: regions }, r, "matrix_date_rows");
    void api
      .patch(`/collections/${collection.id}`, { matrix_date_row_count: r, matrix_date_rows: n })
      .then(onChanged);
  };

  const setBind = (key: string) => {
    selectCollection();
    const patch: Record<string, unknown> = { matrix_bind_property: key || null };
    // A fresh custom range starts as today..today+6.
    if (key === "@days_span") {
      if (!spanStart) patch.matrix_date_start = ymd(new Date());
      if (!spanEnd) {
        const d = new Date();
        d.setDate(d.getDate() + 6);
        patch.matrix_date_end = ymd(d);
      }
    }
    void api.patch(`/collections/${collection.id}`, patch).then(onChanged);
  };

  // Region actions (custom grids): tag on enter / tag off on leave / status on
  // enter, applied to the card's own block.
  const [actionsEdit, setActionsEdit] = useState<number | null>(null);
  const [actionsDraft, setActionsDraft] = useState<{
    tag: string;
    tagOnEnter: boolean;
    tagOffLeave: boolean;
    enterStatus: string;
  }>({ tag: "", tagOnEnter: true, tagOffLeave: false, enterStatus: "" });
  const openActions = (i: number) => {
    const def = regions[i];
    setActionsDraft({
      tag: def?.tag ?? "",
      tagOnEnter: def?.tagOnEnter ?? true,
      tagOffLeave: def?.tagOffLeave ?? false,
      enterStatus: def?.enterStatus ?? "",
    });
    setActionsEdit(i);
  };
  const saveActions = () => {
    if (actionsEdit == null) return;
    // Tag names never include the "#" — strip one if it was typed.
    const tag = actionsDraft.tag.trim().toLowerCase().replace(/^#+/, "");
    const next = regions.map((r, idx) =>
      idx === actionsEdit
        ? {
            ...r,
            tag: tag || undefined,
            tagOnEnter: tag ? actionsDraft.tagOnEnter : undefined,
            tagOffLeave: tag ? actionsDraft.tagOffLeave : undefined,
            enterStatus: actionsDraft.enterStatus || undefined,
          }
        : r,
    );
    setActionsEdit(null);
    setRegions(next);
    void api.patch(`/collections/${collection.id}`, { [regionsKey]: next });
  };
  const statusOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const t of types)
      for (const f of t.propertySchema?.fields ?? [])
        if (f.type === "status") for (const o of f.options ?? []) seen.add(o);
    return [...seen];
  }, [types]);

  const addTagTo = async (id: string, tag: string) => {
    try {
      const cur = await api.get<string[]>(`/blocks/${id}/tags`);
      if (!cur.includes(tag)) await api.put(`/blocks/${id}/tags`, { tags: [...cur, tag] });
    } catch {
      /* ignore */
    }
  };
  const removeTagFrom = async (id: string, tag: string) => {
    try {
      const cur = await api.get<string[]>(`/blocks/${id}/tags`);
      if (cur.includes(tag)) await api.put(`/blocks/${id}/tags`, { tags: cur.filter((t) => t !== tag) });
    } catch {
      /* ignore */
    }
  };
  /** Set the card's own status field — only if that value is one of its options. */
  const setOwnStatus = async (item: Item, value: string) => {
    const t = item.blockTypeId ? types.find((x) => x.id === item.blockTypeId) : undefined;
    const f = statusFieldOf(t);
    if (!f || !(f.options ?? []).includes(value)) return;
    try {
      const b = await api.get<Block>(`/blocks/${item.id}`);
      await api.patch(`/blocks/${item.id}`, {
        properties: { ...(b.properties ?? {}), [f.key]: value },
        version: b.version,
      });
    } catch {
      /* ignore */
    }
  };
  const applyRegionEnter = async (item: Item, region: number) => {
    const def = regions[region];
    if (!def) return;
    if (def.tag && (def.tagOnEnter ?? true)) await addTagTo(item.id, def.tag);
    if (def.enterStatus) await setOwnStatus(item, def.enterStatus);
  };
  const applyRegionLeave = async (item: Item, region: number | null) => {
    if (region == null) return;
    const def = regions[region];
    if (def?.tag && def.tagOffLeave) await removeTagFrom(item.id, def.tag);
  };
  const regionOf = (blockId: string): number | null => {
    const m = members.find((x) => x.id === blockId);
    const r = Number((m?.context as Record<string, unknown>)?.region);
    return Number.isInteger(r) && r >= 0 && r < count ? r : null;
  };

  const removeMember = (blockId: string) => {
    const prev = regionOf(blockId);
    const m = members.find((x) => x.id === blockId);
    void api.del(`/collections/${collection.id}/members/${blockId}`).then(async () => {
      if (prev != null && m) await applyRegionLeave(toItem(m), prev);
      onChanged();
      refreshInfo();
      setQueryTick((t) => t + 1);
    });
  };

  /** Set a property on the block itself (bound placement / status cycling). */
  const patchBlockProps = (item: Item, key: string, value: string) => {
    const nextProps = { ...(item.props ?? {}), [key]: value };
    void api
      .patch(`/blocks/${item.id}`, { properties: nextProps, version: item.version })
      .catch(() => {})
      .then(() => {
        onChanged();
        refreshInfo();
        // Optimistic move, then re-run the query so blocks it no longer
        // matches (e.g. now-completed tasks) drop out.
        setMatches((ms) =>
          ms.map((b) => (b.id === item.id ? { ...b, properties: nextProps, version: (b.version ?? 0) + 1 } : b)),
        );
        setQueryTick((t) => t + 1);
      });
  };

  const onStatus = (item: Item, field: FieldDef, next: string) => patchBlockProps(item, field.key, next);

  const setRegionSize = (index: number, size: RegionSize) => {
    const next = regions.map((r, i) => (i === index ? { ...r, size } : r));
    void api.patch(`/collections/${collection.id}`, { [regionsKey]: next }).then(() => onChanged());
  };

  const onDragStart = (e: DragStartEvent) => {
    setActive((e.active.data.current as unknown as Item) ?? null);
  };
  const onDragEnd = (e: DragEndEvent) => {
    setActive(null);
    const item = e.active.data.current as unknown as Item | undefined;
    const overId = e.over?.id;
    if (!item || overId == null) return;
    const over = String(overId);
    if (dateMode) {
      // Vertical moves only: dates own the columns, drops set the row-region.
      if (over.startsWith("row:")) {
        const row = Number(over.slice(4));
        const prev = rowOfCard(item.id);
        if (prev === row) return;
        void api
          .patch(`/collections/${collection.id}`, { matrix_lanes: { ...lanesMap, [item.id]: row } })
          .then(async () => {
            await applyRegionLeave(item, prev);
            await applyRegionEnter(item, row);
            onChanged();
            refreshInfo();
            setQueryTick((t) => t + 1);
          });
      }
      return;
    }
    // Dropped onto another card → reorder there (and move region if different).
    if (over.startsWith("chip:")) {
      if (bound) return; // bound matrices order by status value, not manually
      const targetId = over.slice(5);
      if (targetId === item.id) return;
      const targetRegion = regionOf(targetId);
      if (targetRegion == null) return;
      const m = members.find((x) => x.id === item.id);
      if (item.member) {
        const prev = regionOf(item.id);
        void api
          .patch(`/collections/${collection.id}/members/${item.id}`, {
            context: { ...(m?.context ?? {}), region: targetRegion },
            beforeId: targetId,
          })
          .then(async () => {
            if (prev !== targetRegion) {
              await applyRegionLeave(item, prev);
              await applyRegionEnter(item, targetRegion);
            }
            onChanged();
            refreshInfo();
            setQueryTick((t) => t + 1);
          });
      } else {
        void api
          .post(`/collections/${collection.id}/members`, { blockId: item.id, context: { region: targetRegion } })
          .then(async () => {
            await api.patch(`/collections/${collection.id}/members/${item.id}`, { beforeId: targetId }).catch(() => {});
            await applyRegionEnter(item, targetRegion);
            onChanged();
            refreshInfo();
            setQueryTick((t) => t + 1);
          });
      }
      return;
    }
    if (over.startsWith("r:")) {
      const region = Number(over.slice(2));
      if (bound) {
        const opt = boundOptions[region];
        if (opt != null) patchBlockProps(item, bindKey, opt);
      } else if (item.member) {
        const m = members.find((x) => x.id === item.id);
        const prev = regionOf(item.id);
        if (prev === region) return;
        void api
          .patch(`/collections/${collection.id}/members/${item.id}`, {
            context: { ...(m?.context ?? {}), region },
          })
          .then(async () => {
            await applyRegionLeave(item, prev);
            await applyRegionEnter(item, region);
            onChanged();
            refreshInfo();
            setQueryTick((t) => t + 1);
          });
      } else {
        void api
          .post(`/collections/${collection.id}/members`, { blockId: item.id, context: { region } })
          .then(async () => {
            await applyRegionEnter(item, region);
            onChanged();
            refreshInfo();
            setQueryTick((t) => t + 1);
          });
      }
    } else if (over === "drawer") {
      // Back to the drawer: unbound → remove the membership; status-bound →
      // clear the bound property so it becomes an unplaced match.
      if (bound) patchBlockProps(item, bindKey, "");
      else if (item.member && !dateMode) removeMember(item.id);
    }
  };

  const drawerDrop = useDroppable({ id: "drawer" });
  const drawerItems = dateMode
    ? dateData.loose
    : bound
      ? placement.loose
      : [...placement.loose, ...candidates];
  // Manual drawers are always expandable (they hold the search); smart drawers
  // only expand when there's something to place.
  const canExpand = !isSmart || drawerItems.length > 0;
  useEffect(() => {
    if (!canExpand && drawerOpen) setDrawerOpen(false);
  }, [canExpand, drawerOpen]);
  const gridCols = bound ? boundOptions.length || 1 : cols;
  const regionList: { title: string; color: string | null; size?: RegionSize }[] = bound
    ? boundOptions.map((o) => ({
        title: o,
        color: boundField?.optionColors?.[o] ?? null,
      }))
    : regions;

  // The grid-size / region-binding controls. Moved into the collection's info
  // panel (below), so the matrix page itself stays clean.
  const layoutControls = (
    <div className="matrix-panel-controls">
      {!bound && !dateMode && (
        <>
          <span className="cols-ctl">
            <span className="hint">Columns</span>
            <button className="icon-btn" onClick={() => resize(cols - 1, rows)}>−</button>
            <span className="cols-n">{cols}</span>
            <button className="icon-btn" onClick={() => resize(cols + 1, rows)}>+</button>
          </span>
          <span className="cols-ctl">
            <span className="hint">Rows</span>
            <button className="icon-btn" onClick={() => resize(cols, rows - 1)}>−</button>
            <span className="cols-n">{rows}</span>
            <button className="icon-btn" onClick={() => resize(cols, rows + 1)}>+</button>
          </span>
        </>
      )}
      {isSmart && (
        <label className="matrix-bind">
          <span className="hint">Regions</span>
          <select value={bindKey} onChange={(e) => setBind(e.target.value)}>
            <option value="">Custom grid</option>
            {bindable.map((b) => (
              <option key={b.key} value={b.key}>
                By {b.label}
              </option>
            ))}
            <option value="@days_before">Days · ending today</option>
            <option value="@days_after">Days · starting today</option>
            <option value="@days_around">Days · around today</option>
            <option value="@days_span">Days · custom range</option>
          </select>
        </label>
      )}
      {dateMode && (
        <span className="cols-ctl">
          <span className="hint">Rows</span>
          <button className="icon-btn" onClick={() => resizeDateRows(dRows - 1)}>−</button>
          <span className="cols-n">{dRows}</span>
          <button className="icon-btn" onClick={() => resizeDateRows(dRows + 1)}>+</button>
        </span>
      )}
      {dateMode && bindKey === "@days_span" && (
        <span className="matrix-span-ctl">
          <DateTimePicker
            value={spanStart}
            placeholder="Start"
            onChange={(v) =>
              void api
                .patch(`/collections/${collection.id}`, { matrix_date_start: v.slice(0, 10) })
                .then(onChanged)
            }
          />
          <span className="hint">to</span>
          <DateTimePicker
            value={spanEnd}
            placeholder="End"
            onChange={(v) =>
              void api
                .patch(`/collections/${collection.id}`, { matrix_date_end: v.slice(0, 10) })
                .then(onChanged)
            }
          />
        </span>
      )}
      {dateMode && bindKey !== "@days_span" && (
        <span className="cols-ctl">
          <span className="hint">Days</span>
          <button
            className="icon-btn"
            onClick={() =>
              void api
                .patch(`/collections/${collection.id}`, { matrix_bind_count: Math.max(1, dayCount - 1) })
                .then(onChanged)
            }
          >
            −
          </button>
          <span className="cols-n">{dayCount}</span>
          <button
            className="icon-btn"
            onClick={() =>
              void api
                .patch(`/collections/${collection.id}`, { matrix_bind_count: Math.min(DAYS_MAX, dayCount + 1) })
                .then(onChanged)
            }
          >
            +
          </button>
        </span>
      )}
    </div>
  );

  return (
    <DndContext sensors={sensors} collisionDetection={matrixCollision} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      {header && <div className="row" style={{ margin: "0 0 12px", gap: 14, flexWrap: "wrap" }}>{header}</div>}
      {bottomSlotEl &&
        selectedBlockId === collection.id &&
        createPortal(
          <>
            <div className="panel-divider" />
            <div className="panel-h">Grid layout</div>
            {layoutControls}
          </>,
          bottomSlotEl,
        )}

      {dateMode ? (
        <div className="matrix-wrap">
          <input
            className="matrix-axis-y"
            placeholder="Y axis"
            value={axisY}
            onFocus={selectCollection}
            onChange={(e) => saveAxis("y", e.target.value)}
          />
          <div className="matrix-main">
            <input
              className="matrix-axis-x"
              placeholder="X axis"
              value={axisX}
              onFocus={selectCollection}
              onChange={(e) => saveAxis("x", e.target.value)}
            />
            <div
              className="matrix-date-grid"
              style={{ gridTemplateColumns: `repeat(${days.length || 1}, 1fr)` }}
              onClick={selectCollection}
            >
              {days.map((d, i) => (
                <div
                  key={d}
                  className={`date-head${d === ymd(new Date()) ? " today" : ""}`}
                  style={{ gridColumn: i + 1, gridRow: 1 }}
                >
                  {fmtDayHead(d)}
                </div>
              ))}
              {regions.map((def, r) => (
                <Fragment key={r}>
                  <RowBand
                    index={r}
                    color={def.color}
                    rowStart={rowStartOf(r)}
                    rowSpan={1 + (dateData.subCounts[r] ?? 1)}
                  />
                  <div
                    className={`row-band-head${def.color ? " colored" : ""}`}
                    style={{ gridColumn: "1 / -1", gridRow: rowStartOf(r) }}
                  >
                    <button
                      className="region-color"
                      title="Row color"
                      style={{ background: def.color ?? "var(--border-strong)" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        selectCollection();
                        setColorEdit(r);
                      }}
                    />
                    <input
                      className="region-title"
                      placeholder="Untitled row"
                      value={def.title}
                      onFocus={selectCollection}
                      onChange={(e) => onTitle(r, e.target.value)}
                    />
                    <button
                      className={`icon-btn region-actions${hasActions(def) ? " set" : ""}`}
                      title={hasActions(def) ? "Row actions (configured)" : "Row actions"}
                      onClick={(e) => {
                        e.stopPropagation();
                        selectCollection();
                        openActions(r);
                      }}
                    >
                      <Settings2 size={13} />
                    </button>
                    <span className="region-count">{rowCounts.get(r)?.size || ""}</span>
                  </div>
                </Fragment>
              ))}
              {dateData.bars.map((b, i) => (
                <div
                  key={`${b.item.id}:${i}`}
                  className="date-bar"
                  style={{
                    gridColumn: `${b.start + 1} / ${b.end + 2}`,
                    gridRow: rowStartOf(b.row) + 1 + b.sub,
                  }}
                >
                  <Chip item={b.item} onStatus={onStatus} />
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="matrix-wrap">
          <input
            className="matrix-axis-y"
            placeholder="Y axis"
            value={axisY}
            onFocus={selectCollection}
            onChange={(e) => saveAxis("y", e.target.value)}
          />
          <div className="matrix-main">
            <input
              className="matrix-axis-x"
              placeholder="X axis"
              value={axisX}
              onFocus={selectCollection}
              onChange={(e) => saveAxis("x", e.target.value)}
            />
            <div className="matrix-grid" style={{ gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))` }}>
              {regionList.map((def, i) => (
                <RegionCell
                  key={i}
                  index={i}
                  title={def.title}
                  color={def.color}
                  size={def.size}
                  editable={!bound}
                  items={placement.map.get(i) ?? []}
                  onTitle={onTitle}
                  onColor={setColorEdit}
                  onActions={openActions}
                  actionsSet={!bound && hasActions(regions[i])}
                  onRemove={bound ? undefined : removeMember}
                  onStatus={onStatus}
                  onInteract={selectCollection}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      <div
        ref={drawerDrop.setNodeRef}
        className={`matrix-drawer${drawerOpen ? " open" : ""}${drawerDrop.isOver ? " over" : ""}`}
      >
        <button
          className="drawer-handle"
          disabled={!canExpand}
          onClick={() => {
            selectCollection();
            if (canExpand) setDrawerOpen((o) => !o);
          }}
        >
          {canExpand ? (
            drawerOpen ? (
              <ChevronDown size={15} />
            ) : (
              <ChevronUp size={15} />
            )
          ) : (
            <span style={{ width: 15 }} />
          )}
          <span>Drawer</span>
          <span className={`drawer-count${drawerItems.length ? "" : " empty"}`}>
            {drawerItems.length}
          </span>
          <span className="hint" style={{ marginLeft: "auto" }}>
            {!canExpand
              ? "everything placed"
              : dateMode
                ? "matches without a date in range"
                : bound
                  ? "matches without a value — drag into a region"
                  : isSmart
                    ? "query matches — drag into a region"
                    : "drag blocks into a region"}
          </span>
        </button>
        {drawerOpen && (
          <div className="drawer-body">
            {!isSmart && (
              <input
                className="drawer-search"
                placeholder="Search blocks…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            )}
            <div className="drawer-items">
              {drawerItems.length === 0 ? (
                <div className="hint">{isSmart ? "No unplaced matches." : "No matches."}</div>
              ) : (
                drawerItems.map((it) => (
                  <Chip
                    key={it.id}
                    item={it}
                    onRemove={it.member && !bound ? removeMember : undefined}
                    onStatus={onStatus}
                  />
                ))
              )}
            </div>
          </div>
        )}
      </div>

      <DragOverlay dropAnimation={null}>
        {active && (
          <div className="matrix-chip overlay">
            <div className="chip-row">
              <ChipGhost item={active} />
            </div>
          </div>
        )}
      </DragOverlay>
      <MatrixTooltip />

      <ColorPickerModal
        open={colorEdit != null}
        title="Region color"
        value={(colorEdit != null && regions[colorEdit]?.color) || "#5fa4b5"}
        onCancel={() => setColorEdit(null)}
        onSave={onColorSave}
      />

      {actionsEdit != null && (
        <div className="modal-backdrop" onClick={() => setActionsEdit(null)}>
          <div className="modal-card" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
            <h2 className="modal-title">
              Region actions{regions[actionsEdit]?.title ? ` — ${regions[actionsEdit]!.title}` : ""}
            </h2>
            <div className="field">
              <span className="field-label">Region height</span>
              <span className="segmented">
                {(["short", "medium", "tall"] as const).map((s) => (
                  <button
                    key={s}
                    className={`seg${(regions[actionsEdit]?.size ?? "medium") === s ? " active" : ""}`}
                    onClick={() => setRegionSize(actionsEdit, s)}
                  >
                    {pretty(s)}
                  </button>
                ))}
              </span>
            </div>
            <label className="field">
              <span>Tag</span>
              <input
                type="text"
                placeholder="tag name"
                value={actionsDraft.tag}
                onChange={(e) => setActionsDraft((d) => ({ ...d, tag: e.target.value }))}
              />
            </label>
            <label className="row" style={{ gap: 8, marginBottom: 8 }}>
              <input
                type="checkbox"
                checked={actionsDraft.tagOnEnter}
                onChange={(e) => setActionsDraft((d) => ({ ...d, tagOnEnter: e.target.checked }))}
              />
              <span>Add tag when a card enters</span>
            </label>
            <label className="row" style={{ gap: 8, marginBottom: 14 }}>
              <input
                type="checkbox"
                checked={actionsDraft.tagOffLeave}
                onChange={(e) => setActionsDraft((d) => ({ ...d, tagOffLeave: e.target.checked }))}
              />
              <span>Remove tag when a card leaves</span>
            </label>
            <label className="field">
              <span>Set status when a card enters</span>
              <select
                value={actionsDraft.enterStatus}
                onChange={(e) => setActionsDraft((d) => ({ ...d, enterStatus: e.target.value }))}
              >
                <option value="">— none —</option>
                {statusOptions.map((o) => (
                  <option key={o} value={o}>
                    {pretty(o)}
                  </option>
                ))}
              </select>
            </label>
            <div className="hint" style={{ marginTop: 6 }}>
              Applied when cards are dragged in or out of this region. Status applies only to cards
              whose type has that option.
            </div>
            <div className="modal-actions">
              <button className="ghost" onClick={() => setActionsEdit(null)}>
                Cancel
              </button>
              <button className="primary" onClick={saveActions}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </DndContext>
  );
}
