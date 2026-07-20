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
import { GripVertical, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, type BlockType, type Collection, type Member } from "../api.ts";
import { BlockIcon } from "../lib/icons.tsx";
import { FinderModal } from "../components/FinderModal.tsx";
import { NewItemModal } from "../components/NewItemModal.tsx";

type Format = "bullet" | "ordered" | "checklist";

/** One sortable list row. Owns its own inline edit + autosave. */
function ListItem({
  member,
  type,
  index,
  format,
  syncStatus,
  collectionId,
  onRemove,
}: {
  member: Member;
  type: BlockType | undefined;
  index: number;
  format: Format;
  syncStatus: boolean;
  collectionId: string;
  onRemove: (blockId: string) => void;
}) {
  const sortable = useSortable({ id: member.id });
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };

  const isText = !type || type.isText;
  const schema = type?.propertySchema ?? null;
  const statusKey = schema?.status_field ?? null;
  const statusField = schema?.fields.find((f) => f.type === "status" && f.key === statusKey) ?? null;

  const [content, setContent] = useState(member.content ?? "");
  const [props, setProps] = useState<Record<string, unknown>>(member.properties ?? {});
  const [checked, setChecked] = useState(Boolean(member.context?.checked));
  const versionRef = useRef(member.version);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const patchBlock = async (body: Record<string, unknown>) => {
    try {
      const updated = await api.patch<Member>(`/blocks/${member.id}`, {
        ...body,
        version: versionRef.current,
      });
      versionRef.current = updated.version;
    } catch {
      /* keep local; a refresh will reconcile */
    }
  };

  const debouncedText = (value: string) => {
    if (isText) setContent(value);
    else setProps((p) => ({ ...p, title: value }));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (isText) void patchBlock({ content: value });
      else void patchBlock({ properties: { ...props, title: value } });
    }, 600);
  };

  const status = statusKey ? String(props[statusKey] ?? "") : "";
  const isComplete = Boolean(statusField && schema?.complete_values?.includes(status));

  const cycleStatus = () => {
    if (!statusField) return;
    const opts = statusField.options ?? [];
    const next = opts[(opts.indexOf(status) + 1) % opts.length];
    if (next) {
      const nextProps = { ...props, [statusKey!]: next };
      setProps(nextProps);
      void patchBlock({ properties: nextProps });
    }
  };

  const toggleCheck = () => {
    if (statusField && syncStatus) {
      const completeVals = schema?.complete_values ?? [];
      const next = isComplete ? String(schema?.default_value ?? "") : String(completeVals[0] ?? "");
      const nextProps = { ...props, [statusKey!]: next };
      setProps(nextProps);
      void patchBlock({ properties: nextProps });
    } else {
      setChecked((c) => !c);
      void api.patch(`/collections/${collectionId}/members/${member.id}`, {
        context: { checked: !checked },
      });
    }
  };

  const boxChecked = statusField && syncStatus ? isComplete : checked;
  const text = isText ? content : String(props.title ?? "");

  return (
    <div ref={sortable.setNodeRef} style={style} className={`list-item${boxChecked && format === "checklist" ? " done" : ""}`}>
      <button className="drag-handle" {...sortable.attributes} {...sortable.listeners} title="Drag to reorder">
        <GripVertical size={15} />
      </button>

      {format === "checklist" ? (
        <input type="checkbox" checked={boxChecked} onChange={toggleCheck} className="li-check" />
      ) : format === "ordered" ? (
        <span className="li-marker">{index + 1}.</span>
      ) : (
        <span className="li-marker">•</span>
      )}

      {statusField && format !== "checklist" && (
        <button className="li-status" onClick={cycleStatus} title={`Status: ${status.replace(/_/g, " ")}`}>
          <BlockIcon
            iconKey={statusField.optionIcons?.[status] ?? type?.iconKey}
            color={statusField.optionColors?.[status] ?? type?.iconColor}
            size={17}
          />
        </button>
      )}

      <input
        className="li-text"
        value={text}
        placeholder={isText ? "Item…" : type?.name}
        onChange={(e) => debouncedText(e.target.value)}
      />
      <button className="icon-btn li-remove" title="Remove" onClick={() => onRemove(member.id)}>
        <X size={14} />
      </button>
    </div>
  );
}

export function CollectionView() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const [collection, setCollection] = useState<Collection | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [types, setTypes] = useState<BlockType[]>([]);
  const [loading, setLoading] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [finderOpen, setFinderOpen] = useState(false);
  const [newType, setNewType] = useState<BlockType | null>(null);
  const [titleVal, setTitleVal] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const titleTimer = useRef<ReturnType<typeof setTimeout>>();

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const typeById = new Map(types.map((t) => [t.id, t]));

  const load = async () => {
    const [data, ts] = await Promise.all([
      api.get<{ collection: Collection; members: Member[] }>(`/collections/${id}`),
      api.get<BlockType[]>("/block-types"),
    ]);
    setCollection(data.collection);
    setMembers(data.members);
    setTitleVal(String(data.collection.properties.title ?? ""));
    setTypes(ts);
  };

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const format = ((collection?.properties.list_format as Format) ?? "bullet") as Format;
  const syncStatus = collection?.properties.sync_checkbox_with_status !== false;

  const saveTitle = (v: string) => {
    setTitleVal(v);
    if (titleTimer.current) clearTimeout(titleTimer.current);
    titleTimer.current = setTimeout(() => void api.patch(`/collections/${id}`, { title: v }), 600);
  };

  const setFormat = (f: Format) => {
    setCollection((c) => (c ? { ...c, properties: { ...c.properties, list_format: f } } : c));
    void api.patch(`/collections/${id}`, { list_format: f });
  };

  const onRemove = async (blockId: string) => {
    setMembers((m) => m.filter((x) => x.id !== blockId));
    await api.del(`/collections/${id}/members/${blockId}`);
  };

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldI = members.findIndex((m) => m.id === active.id);
    const newI = members.findIndex((m) => m.id === over.id);
    if (oldI < 0 || newI < 0) return;
    const arr = arrayMove(members, oldI, newI);
    setMembers(arr);
    const afterId = arr[newI - 1]?.id ?? null;
    const beforeId = arr[newI + 1]?.id ?? null;
    void api.patch(`/collections/${id}/members/${String(active.id)}`, { afterId, beforeId });
  };

  const ordered = [...types].sort((a, b) =>
    a.isText === b.isText ? a.name.localeCompare(b.name) : a.isText ? -1 : 1,
  );

  if (loading) return <div className="hint">Loading…</div>;
  if (!collection) return <div className="hint">Collection not found.</div>;

  return (
    <>
      <button className="ghost" onClick={() => nav("/collections")} style={{ marginBottom: 10 }}>
        ← Collections
      </button>
      <input
        className="collection-title"
        value={titleVal}
        placeholder="Untitled list"
        onChange={(e) => saveTitle(e.target.value)}
      />

      <div className="row" style={{ margin: "14px 0 18px", gap: 14 }}>
        <div className="segmented">
          {(["bullet", "ordered", "checklist"] as Format[]).map((f) => (
            <button
              key={f}
              className={`seg${format === f ? " active" : ""}`}
              onClick={() => setFormat(f)}
            >
              {f}
            </button>
          ))}
        </div>
        <div className="nav-kebab" ref={menuRef} style={{ position: "relative" }}>
          <button className="primary" onClick={() => setMenuOpen((o) => !o)}>
            + Add
          </button>
          {menuOpen && (
            <div className="menu" style={{ left: 0, right: "auto" }}>
              <button
                className="menu-item"
                onClick={() => {
                  setFinderOpen(true);
                  setMenuOpen(false);
                }}
              >
                Find existing…
              </button>
              <div className="menu-sep" />
              {ordered.map((t) => (
                <button
                  key={t.id}
                  className="menu-item type-item"
                  onClick={() => {
                    setNewType(t);
                    setMenuOpen(false);
                  }}
                >
                  <BlockIcon iconKey={t.isText ? "type" : t.iconKey} color={t.iconColor} size={16} />
                  <span style={{ textTransform: "capitalize" }}>New: {t.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {members.length === 0 ? (
        <div className="hint">Empty list. Add an item.</div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={members.map((m) => m.id)} strategy={verticalListSortingStrategy}>
            <div className="list-items">
              {members.map((m, i) => (
                <ListItem
                  key={m.id}
                  member={m}
                  type={m.blockTypeId ? typeById.get(m.blockTypeId) : undefined}
                  index={i}
                  format={format}
                  syncStatus={syncStatus}
                  collectionId={id}
                  onRemove={onRemove}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {finderOpen && (
        <FinderModal
          collectionId={id}
          types={types}
          onClose={() => setFinderOpen(false)}
          onAdded={() => void load()}
        />
      )}
      {newType && (
        <NewItemModal
          collectionId={id}
          type={newType}
          onClose={() => {
            setNewType(null);
            void load();
          }}
        />
      )}
    </>
  );
}
