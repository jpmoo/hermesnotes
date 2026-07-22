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
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type BlockType, type Collection, type Member } from "../api.ts";
import { oneLineText } from "../lib/display.ts";
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
  member: boolean; // already a member (vs a drawer candidate)
}

const REGION_MAX = 6;

function readRegions(props: Record<string, unknown>, count: number): RegionDef[] {
  const raw = Array.isArray(props.matrix_regions) ? (props.matrix_regions as RegionDef[]) : [];
  return Array.from({ length: count }, (_, i) => ({
    title: String(raw[i]?.title ?? ""),
    color: (raw[i]?.color as string | null) ?? null,
  }));
}

/** One draggable chip (a placed member or a drawer candidate). */
function Chip({ item, onRemove }: { item: Item; onRemove?: (id: string) => void }) {
  const { selectBlock } = usePanels();
  const drag = useDraggable({
    id: `${item.member ? "m" : "c"}:${item.id}`,
    data: item as unknown as Record<string, unknown>,
  });
  return (
    <div
      ref={drag.setNodeRef}
      {...drag.attributes}
      {...drag.listeners}
      className={`matrix-chip${drag.isDragging ? " dragging" : ""}`}
      onClick={() => selectBlock(item.id)}
    >
      <ChipBody item={item} />
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
  );
}

function ChipBody({ item }: { item: Item }) {
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

function RegionCell({
  index,
  def,
  items,
  onTitle,
  onColor,
  onRemove,
}: {
  index: number;
  def: RegionDef;
  items: Item[];
  onTitle: (index: number, title: string) => void;
  onColor: (index: number) => void;
  onRemove: (id: string) => void;
}) {
  const drop = useDroppable({ id: `r:${index}` });
  return (
    <div
      ref={drop.setNodeRef}
      className={`matrix-region${drop.isOver ? " over" : ""}`}
      style={def.color ? { background: `${def.color}1a`, borderColor: `${def.color}66` } : undefined}
    >
      <div className="region-head">
        <button
          className="region-color"
          title="Region color"
          style={{ background: def.color ?? "var(--border-strong)" }}
          onClick={() => onColor(index)}
        />
        <input
          className="region-title"
          placeholder="Untitled region"
          value={def.title}
          onChange={(e) => onTitle(index, e.target.value)}
        />
        <span className="hint">{items.length || ""}</span>
      </div>
      <div className="region-body">
        {items.map((it) => (
          <Chip key={it.id} item={it} onRemove={onRemove} />
        ))}
      </div>
    </div>
  );
}

/**
 * Matrix collection: an x/y grid of titled, colored regions. Members are placed
 * by dragging from the bottom drawer (query matches for smart matrices, a
 * search for manual ones) into a region; context.region holds the placement.
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

  const props = collection.properties;
  const isSmart = props.membership_mode === "smart";
  const cols = Math.min(REGION_MAX, Math.max(1, Number(props.matrix_cols) || 2));
  const rows = Math.min(REGION_MAX, Math.max(1, Number(props.matrix_rows) || 2));
  const count = cols * rows;

  const [regions, setRegions] = useState<RegionDef[]>(() => readRegions(props, count));
  const [colorEdit, setColorEdit] = useState<number | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [q, setQ] = useState("");
  const [candidates, setCandidates] = useState<Item[]>([]);
  const [active, setActive] = useState<Item | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();

  // Re-sync region config when the collection reloads or resizes.
  useEffect(() => {
    setRegions(readRegions(collection.properties, count));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collection, count]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const memberIds = useMemo(() => new Set(members.map((m) => m.id)), [members]);
  const byRegion = useMemo(() => {
    const map = new Map<number, Item[]>();
    const loose: Item[] = [];
    for (const m of members) {
      const item: Item = {
        id: m.id,
        blockTypeId: m.blockTypeId,
        label: oneLineText(m.properties, m.content) || "Untitled",
        member: true,
      };
      const r = Number((m.context as Record<string, unknown>)?.region);
      if (Number.isInteger(r) && r >= 0 && r < count) {
        map.set(r, [...(map.get(r) ?? []), item]);
      } else {
        loose.push(item);
      }
    }
    return { map, loose };
  }, [members, count]);

  // Drawer candidates: smart → query matches; manual → search. Minus members.
  useEffect(() => {
    if (!drawerOpen) return;
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
  }, [drawerOpen, q, isSmart, memberIds, props.filter_query]);

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
    const c = Math.min(REGION_MAX, Math.max(1, nextCols));
    const r = Math.min(REGION_MAX, Math.max(1, nextRows));
    const n = readRegions({ ...props, matrix_regions: regions }, c * r);
    void api
      .patch(`/collections/${collection.id}`, { matrix_cols: c, matrix_rows: r, matrix_regions: n })
      .then(onChanged);
  };

  const removeMember = (blockId: string) => {
    void api.del(`/collections/${collection.id}/members/${blockId}`).then(onChanged);
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
    if (over.startsWith("r:")) {
      const region = Number(over.slice(2));
      if (item.member) {
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
    } else if (over === "drawer" && item.member) {
      removeMember(item.id);
    }
  };

  const drawerDrop = useDroppable({ id: "drawer" });
  const drawerItems = [...byRegion.loose, ...candidates];

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <div className="row" style={{ margin: "0 0 12px", gap: 14 }}>
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
      </div>

      <div className="matrix-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {regions.map((def, i) => (
          <RegionCell
            key={i}
            index={i}
            def={def}
            items={byRegion.map.get(i) ?? []}
            onTitle={onTitle}
            onColor={setColorEdit}
            onRemove={removeMember}
          />
        ))}
      </div>

      <div
        ref={drawerDrop.setNodeRef}
        className={`matrix-drawer${drawerOpen ? " open" : ""}${drawerDrop.isOver ? " over" : ""}`}
      >
        <button className="drawer-handle" onClick={() => setDrawerOpen((o) => !o)}>
          {drawerOpen ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
          <span>
            Drawer
            {drawerItems.length > 0 ? ` · ${drawerItems.length}` : ""}
          </span>
          <span className="hint" style={{ marginLeft: "auto" }}>
            {isSmart ? "query matches — drag into a region" : "drag blocks into a region"}
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
                  <Chip key={it.id} item={it} onRemove={it.member ? removeMember : undefined} />
                ))
              )}
            </div>
          </div>
        )}
      </div>

      <DragOverlay>
        {active && (
          <div className="matrix-chip overlay">
            <ChipBody item={active} />
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
