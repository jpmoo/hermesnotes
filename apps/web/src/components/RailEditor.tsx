import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Archive,
  CalendarDays,
  Eye,
  EyeOff,
  GripVertical,
  Layers,
  Library,
  ListChecks,
  Minus,
  MoveVertical,
  Plus,
  RectangleHorizontal,
  Search,
  Shapes,
  Star,
  X,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import {
  DEFAULT_RAIL,
  normalizeRail,
  normalizeStartPage,
  RAIL_LAYOUT_PREF_KEY,
  START_PAGE_OPTIONS,
  START_PAGE_PREF_KEY,
  type RailButtonId,
  type RailItem,
} from "@hermes/shared";
import { usePreferences } from "../lib/preferences.tsx";

/** Label + icon for each rail button, mirroring the Sidebar. */
const RAIL_META: Record<RailButtonId, { label: string; Icon: LucideIcon }> = {
  new: { label: "New…", Icon: Plus },
  search: { label: "Search", Icon: Search },
  today: { label: "Today", Icon: CalendarDays },
  favorites: { label: "Favorites", Icon: Star },
  blocks: { label: "All blocks", Icon: Layers },
  collections: { label: "Collections", Icon: Library },
  types: { label: "Types", Icon: Shapes },
  review: { label: "Weekly Review", Icon: ListChecks },
  archive: { label: "Archive", Icon: Archive },
};

const DIVIDER_META = {
  line: { label: "Divider line", Icon: Minus },
  flex: { label: "Flexible space", Icon: MoveVertical },
  gap: { label: "Fixed gap", Icon: RectangleHorizontal },
} as const;

type UItem = RailItem & { uid: string };
let seq = 0;
const withUids = (items: RailItem[]): UItem[] => items.map((it) => ({ ...it, uid: `u${seq++}` }));

function Row({
  item,
  onToggle,
  onRemove,
}: {
  item: UItem;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const sortable = useSortable({ id: item.uid });
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  return (
    <div ref={sortable.setNodeRef} style={style} className={`sec-row rail-edit-row${item.kind === "button" && item.hidden ? " hidden" : ""}`}>
      <button className="drag-handle" {...sortable.attributes} {...sortable.listeners} title="Drag to reorder">
        <GripVertical size={14} />
      </button>
      {item.kind === "button" ? (
        (() => {
          const { label, Icon } = RAIL_META[item.id];
          return (
            <>
              <Icon size={15} className="rail-edit-icon" />
              <span className="sec-label">{label}</span>
              <button
                className="icon-btn sec-remove"
                title={item.hidden ? "Show" : "Hide"}
                onClick={onToggle}
              >
                {item.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </>
          );
        })()
      ) : (
        <>
          {(() => {
            const { label, Icon } = DIVIDER_META[item.kind];
            return (
              <>
                <Icon size={15} className="rail-edit-icon" />
                <span className="sec-label rail-edit-divider">{label}</span>
              </>
            );
          })()}
          <button className="icon-btn sec-remove" title="Remove" onClick={onRemove}>
            <X size={13} />
          </button>
        </>
      )}
    </div>
  );
}

/**
 * Rearrange the sidebar's middle section: show/hide, reorder, and insert divider
 * lines / spacers. The top brand and bottom utilities are fixed. Persists to the
 * synced `rail_layout` preference, which the Sidebar renders from live.
 */
export function RailEditor() {
  const { prefs, setPref } = usePreferences();
  const [items, setItems] = useState<UItem[]>(() => withUids(normalizeRail(prefs[RAIL_LAYOUT_PREF_KEY])));
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const commit = (next: UItem[]) => {
    setItems(next);
    setPref(
      RAIL_LAYOUT_PREF_KEY,
      next.map(({ uid: _uid, ...rest }) => rest),
    );
  };

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = items.findIndex((i) => i.uid === active.id);
    const to = items.findIndex((i) => i.uid === over.id);
    if (from < 0 || to < 0) return;
    commit(arrayMove(items, from, to));
  };
  const toggle = (uid: string) =>
    commit(items.map((i) => (i.uid === uid && i.kind === "button" ? { ...i, hidden: !i.hidden } : i)));
  const remove = (uid: string) => commit(items.filter((i) => i.uid !== uid));
  const add = (kind: "line" | "flex" | "gap") => commit([...items, ...withUids([{ kind }])]);

  return (
    <div className="card">
      <div className="panel-h" style={{ marginTop: 0 }}>Sidebar layout</div>
      <p className="hint" style={{ marginTop: 0 }}>
        Show/hide, reorder, and add spacers to the rail's middle section. The logo (top) and Dark
        mode / Settings / Sign out (bottom) stay fixed.
      </p>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items.map((i) => i.uid)} strategy={verticalListSortingStrategy}>
          <div className="rail-edit-list">
            {items.map((it) => (
              <Row key={it.uid} item={it} onToggle={() => toggle(it.uid)} onRemove={() => remove(it.uid)} />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <button className="ghost" onClick={() => add("line")}>
          <Minus size={13} /> Line
        </button>
        <button className="ghost" onClick={() => add("flex")}>
          <MoveVertical size={13} /> Flexible space
        </button>
        <button className="ghost" onClick={() => add("gap")}>
          <RectangleHorizontal size={13} /> Fixed gap
        </button>
        <button className="ghost" style={{ marginLeft: "auto" }} onClick={() => commit(withUids(DEFAULT_RAIL))}>
          Reset to default
        </button>
      </div>

      <label className="field" style={{ marginTop: 18 }}>
        <span>Start page</span>
        <select
          value={normalizeStartPage(prefs[START_PAGE_PREF_KEY])}
          onChange={(e) => setPref(START_PAGE_PREF_KEY, e.target.value)}
        >
          {START_PAGE_OPTIONS.map((o) => (
            <option key={o.path} value={o.path}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="hint">Where you land when you sign in or open the app at its root.</span>
      </label>
    </div>
  );
}
