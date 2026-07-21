import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Lock, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type BlockSearchResult, type Collection } from "../api.ts";
import { oneLineText } from "../lib/display.ts";

export interface SectionEntry {
  id: string;
  label: string;
  removable: boolean;
}

function Row({
  entry,
  canReorder,
  canModify,
  onRemove,
}: {
  entry: SectionEntry;
  canReorder: boolean;
  canModify: boolean;
  onRemove: (id: string) => void;
}) {
  const sortable = useSortable({ id: entry.id, disabled: !canReorder });
  const style = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };
  return (
    <div ref={sortable.setNodeRef} style={style} className="sec-row">
      {canReorder ? (
        <button
          className="drag-handle"
          {...sortable.attributes}
          {...sortable.listeners}
          title="Drag to reorder"
        >
          <GripVertical size={14} />
        </button>
      ) : (
        <span className="drag-handle disabled">
          <Lock size={12} />
        </span>
      )}
      <span className="sec-label">{entry.label}</span>
      {canModify && entry.removable && (
        <button className="icon-btn sec-remove" title="Remove section" onClick={() => onRemove(entry.id)}>
          <X size={13} />
        </button>
      )}
    </div>
  );
}

/** Add-section popover: pick an existing collection or search a note. */
function AddMenu({
  onAddCollection,
  onAddNote,
  onClose,
}: {
  onAddCollection: (id: string) => void;
  onAddNote: (id: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"collection" | "note">("collection");
  const [collections, setCollections] = useState<Collection[]>([]);
  const [q, setQ] = useState("");
  const [notes, setNotes] = useState<BlockSearchResult[]>([]);

  useEffect(() => {
    void api.get<Collection[]>("/collections").then(setCollections);
  }, []);
  useEffect(() => {
    if (tab !== "note") return;
    const t = setTimeout(() => {
      void api
        .get<BlockSearchResult[]>(`/blocks/search?q=${encodeURIComponent(q)}`)
        .then(setNotes)
        .catch(() => setNotes([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q, tab]);

  return (
    <div className="sec-add-menu">
      <div className="segmented" style={{ marginBottom: 8 }}>
        <button className={`seg${tab === "collection" ? " active" : ""}`} onClick={() => setTab("collection")}>
          Collection
        </button>
        <button className={`seg${tab === "note" ? " active" : ""}`} onClick={() => setTab("note")}>
          Note
        </button>
      </div>
      {tab === "collection" ? (
        <div className="sec-add-list">
          {collections.map((c) => (
            <button
              key={c.id}
              className="menu-item"
              onClick={() => {
                onAddCollection(c.id);
                onClose();
              }}
            >
              {oneLineText(c.properties) || "Untitled"}
            </button>
          ))}
          {collections.length === 0 && <div className="hint">No collections yet.</div>}
        </div>
      ) : (
        <>
          <input
            autoFocus
            placeholder="Search notes…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="sec-add-list">
            {notes.map((n) => (
              <button
                key={n.id}
                className="menu-item"
                onClick={() => {
                  onAddNote(n.id);
                  onClose();
                }}
              >
                {n.label}
              </button>
            ))}
            {notes.length === 0 && <div className="hint">No matches.</div>}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Interactive section outline used in the right panel by the Today sheet and
 * document collections. Reorder via drag (when `canReorder`); add/remove
 * sections when `canModify`. Fixed sections show a lock instead of a remove.
 */
export function SectionLayout({
  entries,
  canReorder,
  canModify,
  onMove,
  onRemove,
  onAddCollection,
  onAddNote,
}: {
  entries: SectionEntry[];
  canReorder: boolean;
  canModify: boolean;
  onMove: (activeId: string, overId: string) => void;
  onRemove: (id: string) => void;
  onAddCollection: (id: string) => void;
  onAddNote: (id: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (over && active.id !== over.id) onMove(String(active.id), String(over.id));
  };

  return (
    <div className="sec-layout">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={entries.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          {entries.map((s) => (
            <Row
              key={s.id}
              entry={s}
              canReorder={canReorder}
              canModify={canModify}
              onRemove={onRemove}
            />
          ))}
        </SortableContext>
      </DndContext>

      {canModify &&
        (adding ? (
          <AddMenu
            onAddCollection={onAddCollection}
            onAddNote={onAddNote}
            onClose={() => setAdding(false)}
          />
        ) : (
          <button className="ghost sec-add-btn" onClick={() => setAdding(true)}>
            <Plus size={14} /> Add section
          </button>
        ))}
      {!canModify && <div className="hint sec-note">Sections follow the query — reorder disabled.</div>}
    </div>
  );
}
