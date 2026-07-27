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
import type { TodayScope } from "@hermes/shared";
import { api, type BlockSearchResult, type BlockType, type Collection } from "../api.ts";
import { oneLineText } from "../lib/display.ts";
import { BlockIcon, CollectionIcon } from "../lib/icons.tsx";

export interface SectionEntry {
  id: string;
  label: string;
  removable: boolean;
}

const SCOPES: { key: TodayScope; label: string }[] = [
  { key: "today", label: "Just today" },
  { key: "today_forward", label: "Today & future days" },
  { key: "all", label: "All dailies (past, present, future)" },
];

/** The today/today-forward/all chooser shown before a scoped add or remove. */
function ScopeMenu({
  title,
  onPick,
  onClose,
}: {
  title: string;
  onPick: (scope: TodayScope) => void;
  onClose: () => void;
}) {
  return (
    <div className="sec-scope-menu">
      <div className="sec-scope-title">{title}</div>
      {SCOPES.map((s) => (
        <button key={s.key} className="menu-item" onClick={() => onPick(s.key)}>
          {s.label}
        </button>
      ))}
      <button className="menu-item sec-scope-cancel" onClick={onClose}>
        Cancel
      </button>
    </div>
  );
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
  const [types, setTypes] = useState<BlockType[]>([]);
  const [q, setQ] = useState("");
  const [notes, setNotes] = useState<BlockSearchResult[]>([]);

  useEffect(() => {
    void api.get<Collection[]>("/collections").then(setCollections);
    void api.get<BlockType[]>("/block-types").then(setTypes);
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
      <div className="sec-add-head">
        <div className="segmented">
          <button className={`seg${tab === "collection" ? " active" : ""}`} onClick={() => setTab("collection")}>
            Collection
          </button>
          <button className={`seg${tab === "note" ? " active" : ""}`} onClick={() => setTab("note")}>
            Note
          </button>
        </div>
        <button className="icon-btn sec-add-close" title="Close" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      {tab === "collection" ? (
        <div className="sec-add-list">
          {collections.map((c) => (
            <button
              key={c.id}
              className="menu-item type-item"
              onClick={() => {
                onAddCollection(c.id);
                onClose();
              }}
            >
              <CollectionIcon
                document={c.collectionKind === "document"}
                matrix={c.collectionKind === "matrix"}
                table={c.collectionKind === "table"}
                canvas={c.collectionKind === "canvas"}
                calendar={c.collectionKind === "calendar"}
                smart={c.properties.membership_mode === "smart"}
                color={(c.properties.icon_color as string) ?? null}
                size={15}
              />
              <span className="sec-add-label">{oneLineText(c.properties) || "Untitled"}</span>
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
            {notes.map((n) => {
              const t = types.find((x) => x.id === n.blockTypeId);
              return (
                <button
                  key={n.id}
                  className="menu-item type-item"
                  onClick={() => {
                    onAddNote(n.id);
                    onClose();
                  }}
                >
                  <BlockIcon
                    iconKey={!t || t.isText ? "type" : t.iconKey}
                    color={t && !t.isText ? t.iconColor : null}
                    size={15}
                  />
                  <span className="sec-add-label">{n.label}</span>
                </button>
              );
            })}
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
  scoped = false,
  onMove,
  onRemove,
  onAddCollection,
  onAddNote,
}: {
  entries: SectionEntry[];
  canReorder: boolean;
  canModify: boolean;
  /** Today sheets add/remove at a temporal scope (today | today+future | all);
   * documents don't — they just add/remove the one section. */
  scoped?: boolean;
  onMove: (activeId: string, overId: string) => void;
  onRemove: (id: string, scope?: TodayScope) => void;
  onAddCollection: (id: string, scope?: TodayScope) => void;
  onAddNote: (id: string, scope?: TodayScope) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [pendingAdd, setPendingAdd] = useState<{ kind: "collection" | "note"; id: string } | null>(null);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (over && active.id !== over.id) onMove(String(active.id), String(over.id));
  };

  const handleRemove = (id: string) => (scoped ? setPendingRemove(id) : onRemove(id));
  const handleAdd = (kind: "collection" | "note", id: string) => {
    if (scoped) setPendingAdd({ kind, id });
    else if (kind === "collection") onAddCollection(id);
    else onAddNote(id);
  };
  const commitAdd = (scope: TodayScope) => {
    if (!pendingAdd) return;
    if (pendingAdd.kind === "collection") onAddCollection(pendingAdd.id, scope);
    else onAddNote(pendingAdd.id, scope);
    setPendingAdd(null);
  };
  const commitRemove = (scope: TodayScope) => {
    if (pendingRemove) onRemove(pendingRemove, scope);
    setPendingRemove(null);
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
              onRemove={handleRemove}
            />
          ))}
        </SortableContext>
      </DndContext>

      {pendingRemove ? (
        <ScopeMenu title="Remove section from…" onPick={commitRemove} onClose={() => setPendingRemove(null)} />
      ) : pendingAdd ? (
        <ScopeMenu title="Add section to…" onPick={commitAdd} onClose={() => setPendingAdd(null)} />
      ) : canModify ? (
        adding ? (
          <AddMenu
            onAddCollection={(id) => handleAdd("collection", id)}
            onAddNote={(id) => handleAdd("note", id)}
            onClose={() => setAdding(false)}
          />
        ) : (
          <button className="ghost sec-add-btn" onClick={() => setAdding(true)}>
            <Plus size={14} /> Add section
          </button>
        )
      ) : (
        <div className="hint sec-note">Sections follow the query — reorder disabled.</div>
      )}
    </div>
  );
}
