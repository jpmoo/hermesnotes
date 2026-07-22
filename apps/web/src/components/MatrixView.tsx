import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type { FieldDef, PropertySchema } from "@hermes/shared";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Block, type BlockType, type Collection, type Member } from "../api.ts";
import { isOverdue, oneLineText } from "../lib/display.ts";
import { normalizeFilter } from "../lib/filter.ts";
import { BlockIcon } from "../lib/icons.tsx";
import { usePanels } from "../lib/right-panel.tsx";
import { ColorPickerModal } from "./ColorPickerModal.tsx";

interface RegionDef {
  title: string;
  color: string | null;
}

interface Item {
  id: string;
  blockTypeId: string | null;
  label: string;
  member: boolean; // an explicit membership (vs a drawer candidate / bound match)
  props?: Record<string, unknown>;
  version?: number;
}

const REGION_MAX = 6;
const DAYS_MAX = 7;
const pretty = (v: string) => v.replace(/_/g, " ");

// Date-bound region modes: columns are consecutive days.
const DATE_KEYS = ["@days_before", "@days_after", "@days_around"] as const;
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

function readRegions(props: Record<string, unknown>, count: number): RegionDef[] {
  const raw = Array.isArray(props.matrix_regions) ? (props.matrix_regions as RegionDef[]) : [];
  return Array.from({ length: count }, (_, i) => ({
    title: String(raw[i]?.title ?? ""),
    color: (raw[i]?.color as string | null) ?? null,
  }));
}

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
  const done = statusKey
    ? (schema?.complete_values ?? []).includes(String(props[statusKey] ?? ""))
    : false;
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
          overdue: !done && isOverdue(span.end),
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

function statusFieldOf(type: BlockType | undefined): FieldDef | null {
  const schema = type?.propertySchema;
  const key = schema?.status_field;
  return schema?.fields.find((f) => f.type === "status" && f.key === key) ?? null;
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
  const { selectBlock } = usePanels();
  const { types } = useMatrixTypes();
  const drag = useDraggable({
    id: `${item.member ? "m" : "c"}:${item.id}`,
    data: item as unknown as Record<string, unknown>,
  });
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

  return (
    <div
      ref={drag.setNodeRef}
      {...drag.attributes}
      {...drag.listeners}
      className={`matrix-chip${drag.isDragging ? " dragging" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        selectBlock(item.id);
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
              iconKey={statusField.optionIcons?.[status] ?? t?.iconKey}
              color={statusField.optionColors?.[status] ?? t?.iconColor}
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
        <span className="chip-label">{item.label}</span>
        {onRemove && (
          <button
            className="icon-btn chip-remove"
            title="Remove from matrix"
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
      {dates.length > 0 && (
        <div className="chip-dates">
          {dates.map((d, i) =>
            d.overdue ? (
              <span key={i} className="overdue-pill">
                {d.text}
              </span>
            ) : (
              <span key={i}>{d.text}</span>
            ),
          )}
        </div>
      )}
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
      <span className="chip-label">{item.label}</span>
    </>
  );
}

function RegionCell({
  index,
  title,
  color,
  editable,
  items,
  onTitle,
  onColor,
  onRemove,
  onStatus,
  onInteract,
}: {
  index: number;
  title: string;
  color: string | null;
  editable: boolean;
  items: Item[];
  onTitle?: (index: number, title: string) => void;
  onColor?: (index: number) => void;
  onRemove?: (id: string) => void;
  onStatus?: (item: Item, field: FieldDef, next: string) => void;
  onInteract?: () => void;
}) {
  const drop = useDroppable({ id: `r:${index}` });
  return (
    <div
      ref={drop.setNodeRef}
      className={`matrix-region${drop.isOver ? " over" : ""}${color ? " colored" : ""}`}
      style={color ? { background: color, borderColor: color } : undefined}
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

/** A full-width drop strip for one lane in date mode. */
function LaneDrop({ lane }: { lane: number }) {
  const drop = useDroppable({ id: `lane:${lane}` });
  return (
    <div
      ref={drop.setNodeRef}
      className={`lane-drop${drop.isOver ? " over" : ""}`}
      style={{ gridColumn: "1 / -1", gridRow: lane + 2 }}
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
}: {
  collection: Collection;
  members: Member[];
  types: BlockType[];
  onChanged: () => void;
}) {
  typesStore = types;
  typesSubs.forEach((f) => f());

  const { selectBlock } = usePanels();
  // Collection-level interactions make the collection the active block (so its
  // query tools show); card interactions make the card active instead.
  const selectCollection = () => selectBlock(collection.id, { collection: true });

  const props = collection.properties;
  const isSmart = props.membership_mode === "smart";
  const bindKey = typeof props.matrix_bind_property === "string" ? props.matrix_bind_property : "";
  const dateMode = isSmart && (DATE_KEYS as readonly string[]).includes(bindKey);
  const bound = isSmart && !!bindKey && !dateMode; // status-bound
  const dayCount = Math.min(DAYS_MAX, Math.max(1, Number(props.matrix_bind_count) || 3));
  const days = useMemo(() => (dateMode ? dayList(bindKey, dayCount) : []), [dateMode, bindKey, dayCount]);
  const lanesMap = useMemo(
    () => (props.matrix_lanes && typeof props.matrix_lanes === "object" ? (props.matrix_lanes as Record<string, number>) : {}),
    [props.matrix_lanes],
  );

  const cols = Math.min(REGION_MAX, Math.max(1, Number(props.matrix_cols) || 2));
  const rows = Math.min(REGION_MAX, Math.max(1, Number(props.matrix_rows) || 2));
  const count = cols * rows;

  const [regions, setRegions] = useState<RegionDef[]>(() => readRegions(props, count));
  const [colorEdit, setColorEdit] = useState<number | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [q, setQ] = useState("");
  const [candidates, setCandidates] = useState<Item[]>([]);
  const [matches, setMatches] = useState<Block[]>([]); // smart: full query matches
  const [queryTick, setQueryTick] = useState(0); // bump to re-run the query
  const [active, setActive] = useState<Item | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    setRegions(readRegions(collection.properties, count));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collection, count]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

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
    member: true,
    props: m.properties,
    version: m.version,
  });
  const blockToItem = (b: Block): Item => ({
    id: b.id,
    blockTypeId: b.blockTypeId,
    label: oneLineText(b.properties, b.content) || "Untitled",
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
          found = res.blocks.map((b) => ({ ...b, member: false }));
        } else {
          const res = await api.get<{ id: string; blockTypeId: string | null; label: string }[]>(
            `/blocks/search?q=${encodeURIComponent(q)}`,
          );
          found = res.map((b) => ({ ...b, member: false }));
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

  // Date mode: contiguous day-runs per block ("bars"), stacked in lanes. A
  // block keeps ONE lane so its bars align across columns; explicit lanes come
  // from matrix_lanes, the rest pack into the first non-overlapping lane.
  const dateData = useMemo(() => {
    const empty = { bars: [] as { item: Item; start: number; end: number; lane: number }[], loose: [] as Item[], laneCount: 0 };
    if (!dateMode) return empty;
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
    const laneSpans: [number, number][][] = [];
    const overlaps = (lane: number, runs: [number, number][]) =>
      (laneSpans[lane] ?? []).some(([s1, e1]) => runs.some(([s2, e2]) => s1 <= e2 && s2 <= e1));
    const bars: { item: Item; start: number; end: number; lane: number }[] = [];
    for (const bw of withRuns) {
      let lane = lanesMap[bw.item.id];
      if (!Number.isInteger(lane) || lane! < 0 || overlaps(lane!, bw.runs)) {
        lane = 0;
        while (overlaps(lane, bw.runs)) lane++;
      }
      laneSpans[lane!] = [...(laneSpans[lane!] ?? []), ...bw.runs];
      for (const [rs, re] of bw.runs) bars.push({ item: bw.item, start: rs, end: re, lane: lane! });
    }
    return { bars, loose, laneCount: laneSpans.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateMode, matches, days, types, lanesMap]);

  const setLane = (blockId: string, lane: number) => {
    void api
      .patch(`/collections/${collection.id}`, { matrix_lanes: { ...lanesMap, [blockId]: lane } })
      .then(onChanged);
  };

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
      () => void api.patch(`/collections/${collection.id}`, { matrix_regions: next }),
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
    void api.patch(`/collections/${collection.id}`, { matrix_regions: next });
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

  const setBind = (key: string) => {
    selectCollection();
    void api.patch(`/collections/${collection.id}`, { matrix_bind_property: key || null }).then(onChanged);
  };

  const removeMember = (blockId: string) => {
    void api.del(`/collections/${collection.id}/members/${blockId}`).then(onChanged);
  };

  /** Set a property on the block itself (bound placement / status cycling). */
  const patchBlockProps = (item: Item, key: string, value: string) => {
    const nextProps = { ...(item.props ?? {}), [key]: value };
    void api
      .patch(`/blocks/${item.id}`, { properties: nextProps, version: item.version })
      .catch(() => {})
      .then(() => {
        onChanged();
        // Optimistic move, then re-run the query so blocks it no longer
        // matches (e.g. now-completed tasks) drop out.
        setMatches((ms) =>
          ms.map((b) => (b.id === item.id ? { ...b, properties: nextProps, version: (b.version ?? 0) + 1 } : b)),
        );
        setQueryTick((t) => t + 1);
      });
  };

  const onStatus = (item: Item, field: FieldDef, next: string) => patchBlockProps(item, field.key, next);

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
      // Vertical moves only: dates own the columns, drops set the lane.
      if (over.startsWith("lane:")) setLane(item.id, Number(over.slice(5)));
      return;
    }
    if (over.startsWith("r:")) {
      const region = Number(over.slice(2));
      if (bound) {
        const opt = boundOptions[region];
        if (opt != null) patchBlockProps(item, bindKey, opt);
      } else if (item.member) {
        const m = members.find((x) => x.id === item.id);
        const cur = Number((m?.context as Record<string, unknown>)?.region);
        if (cur === region) return;
        void api
          .patch(`/collections/${collection.id}/members/${item.id}`, {
            context: { ...(m?.context ?? {}), region },
          })
          .then(onChanged);
      } else {
        void api
          .post(`/collections/${collection.id}/members`, { blockId: item.id, context: { region } })
          .then(onChanged);
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
  const regionList: { title: string; color: string | null }[] = bound
    ? boundOptions.map((o) => ({
        title: o,
        color: boundField?.optionColors?.[o] ?? null,
      }))
    : regions;

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <div className="row" style={{ margin: "0 0 12px", gap: 14, flexWrap: "wrap" }}>
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
            </select>
          </label>
        )}
        {dateMode && (
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

      {dateMode ? (
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
          {Array.from({ length: dateData.laneCount + 1 }, (_, L) => (
            <LaneDrop key={L} lane={L} />
          ))}
          {dateData.bars.map((b, i) => (
            <div
              key={`${b.item.id}:${i}`}
              className="date-bar"
              style={{ gridColumn: `${b.start + 1} / ${b.end + 2}`, gridRow: b.lane + 2 }}
            >
              <Chip item={b.item} onStatus={onStatus} />
            </div>
          ))}
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
            <div className="matrix-grid" style={{ gridTemplateColumns: `repeat(${gridCols}, 1fr)` }}>
              {regionList.map((def, i) => (
                <RegionCell
                  key={i}
                  index={i}
                  title={def.title}
                  color={def.color}
                  editable={!bound}
                  items={placement.map.get(i) ?? []}
                  onTitle={onTitle}
                  onColor={setColorEdit}
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

      <ColorPickerModal
        open={colorEdit != null}
        title="Region color"
        value={(colorEdit != null && regions[colorEdit]?.color) || "#5fa4b5"}
        onCancel={() => setColorEdit(null)}
        onSave={onColorSave}
      />
    </DndContext>
  );
}
