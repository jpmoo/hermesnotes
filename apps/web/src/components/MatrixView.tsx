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
const pretty = (v: string) => v.replace(/_/g, " ");

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
  const bound = isSmart && !!bindKey;

  const cols = Math.min(REGION_MAX, Math.max(1, Number(props.matrix_cols) || 2));
  const rows = Math.min(REGION_MAX, Math.max(1, Number(props.matrix_rows) || 2));
  const count = cols * rows;

  const [regions, setRegions] = useState<RegionDef[]>(() => readRegions(props, count));
  const [colorEdit, setColorEdit] = useState<number | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [q, setQ] = useState("");
  const [candidates, setCandidates] = useState<Item[]>([]);
  const [matches, setMatches] = useState<Block[]>([]); // bound mode: full query matches
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

  // Bound mode: fetch full query matches (with properties) to auto-place.
  useEffect(() => {
    if (!bound) return;
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
  }, [bound, JSON.stringify(props.filter_query), collection.updatedAt]);

  const memberIds = useMemo(() => new Set(members.map((m) => m.id)), [members]);

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
        const item = toItem(m);
        const r = Number((m.context as Record<string, unknown>)?.region);
        if (Number.isInteger(r) && r >= 0 && r < count) map.set(r, [...(map.get(r) ?? []), item]);
        else loose.push(item);
      }
    }
    return { map, loose };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bound, matches, members, count, bindKey, boundOptions.join("|")]);

  // Drawer candidates (unbound only): smart → query matches (fetched eagerly so
  // the closed drawer can show its count); manual → search once opened.
  useEffect(() => {
    if (bound) return;
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
        if (bound) {
          setMatches((ms) =>
            ms.map((b) => (b.id === item.id ? { ...b, properties: nextProps, version: (b.version ?? 0) + 1 } : b)),
          );
        }
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
    } else if (over === "drawer" && item.member && !bound) {
      removeMember(item.id);
    }
  };

  const drawerDrop = useDroppable({ id: "drawer" });
  const drawerItems = bound ? placement.loose : [...placement.loose, ...candidates];
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
        {!bound && (
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
        {isSmart && bindable.length > 0 && (
          <label className="matrix-bind">
            <span className="hint">Regions</span>
            <select value={bindKey} onChange={(e) => setBind(e.target.value)}>
              <option value="">Custom grid</option>
              {bindable.map((b) => (
                <option key={b.key} value={b.key}>
                  By {b.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

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

      <DragOverlay>
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
