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
import { ArrowLeft, ChevronDown, ChevronUp, GripVertical, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, type Block, type BlockType, type Collection, type Member } from "../api.ts";
import { BlockIcon } from "../lib/icons.tsx";
import { oneLineHtml, oneLineText } from "../lib/display.ts";
import { FinderModal } from "../components/FinderModal.tsx";
import { NewItemModal } from "../components/NewItemModal.tsx";
import { BlockCard } from "../components/BlockCard.tsx";
import { CollectionSection } from "../components/CollectionSection.tsx";
import { QueryPanel } from "../components/QueryPanel.tsx";
import { SectionLayout, type SectionEntry } from "../components/SectionLayout.tsx";
import { TextBlockEditor } from "../components/TextBlockEditor.tsx";
import { TypedBlockCard } from "../components/TypedBlockCard.tsx";
import { usePanels } from "../lib/right-panel.tsx";
import { useBlockView } from "../lib/useBlockView.tsx";

type Format = "bullet" | "ordered" | "checklist" | "blocks";

/** A draggable document section row (a full card with a grip handle). */
function DocSection({
  id,
  draggable,
  children,
}: {
  id: string;
  draggable: boolean;
  children: ReactNode;
}) {
  const s = useSortable({ id, disabled: !draggable });
  // Translate (not Transform) so variable-height cards don't stretch mid-drag.
  const style = { transform: CSS.Translate.toString(s.transform), transition: s.transition };
  return (
    <div ref={s.setNodeRef} style={style} className="doc-section-row">
      {draggable && (
        <button className="drag-handle doc-grip" {...s.attributes} {...s.listeners} title="Drag to reorder">
          <GripVertical size={15} />
        </button>
      )}
      <div className="doc-section-body">{children}</div>
    </div>
  );
}

/** One sortable list row. Owns its own inline edit + autosave. */
function ListItem({
  member,
  type,
  index,
  format,
  syncStatus,
  collectionId,
  onRemove,
  readonly = false,
}: {
  member: Member;
  type: BlockType | undefined;
  index: number;
  format: Format;
  syncStatus: boolean;
  collectionId: string;
  onRemove: (blockId: string) => void;
  readonly?: boolean;
}) {
  const sortable = useSortable({ id: member.id });
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };

  const isText = !type || type.isText;
  const schema = type?.propertySchema ?? null;
  const statusKey = schema?.status_field ?? null;
  const statusField = schema?.fields.find((f) => f.type === "status" && f.key === statusKey) ?? null;

  const asCard = format === "blocks";
  const [content, setContent] = useState(member.content ?? "");
  const [props, setProps] = useState<Record<string, unknown>>(member.properties ?? {});
  const [checked, setChecked] = useState(Boolean(member.context?.checked));
  const [expanded, setExpanded] = useState(asCard);
  const [fullBlock, setFullBlock] = useState<Block | null>(null);
  const versionRef = useRef(member.version);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (expanded && !fullBlock) void api.get<Block>(`/blocks/${member.id}`).then(setFullBlock);
  }, [expanded, fullBlock, member.id]);
  const reloadFull = () => void api.get<Block>(`/blocks/${member.id}`).then(setFullBlock);

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
  const multiline = isText && content.includes("\n");
  const restCount = (schema?.fields ?? []).filter(
    (f) => f.key !== "title" && f.key !== statusKey,
  ).length;
  const hasMore = isText ? multiline || content.length > 80 : restCount > 0;

  // "blocks" format: every item is a full editable card with a slim header.
  if (asCard) {
    return (
      <div ref={sortable.setNodeRef} style={style} className="list-item-wrap block-item">
        <div className="list-item card-head">
          {!readonly && (
            <button
              className="drag-handle"
              {...sortable.attributes}
              {...sortable.listeners}
              title="Drag to reorder"
            >
              <GripVertical size={15} />
            </button>
          )}
          <span style={{ flex: 1 }} />
          {!readonly && (
            <button className="icon-btn li-remove" title="Remove" onClick={() => onRemove(member.id)}>
              <X size={14} />
            </button>
          )}
        </div>
        <div className="list-item-expanded">
          {!fullBlock ? (
            <div className="hint">Loading…</div>
          ) : isText ? (
            <TextBlockEditor block={fullBlock} type={type} onConflict={reloadFull} onDeleted={() => onRemove(member.id)} />
          ) : (
            <TypedBlockCard block={fullBlock} type={type!} onConflict={reloadFull} onDeleted={() => onRemove(member.id)} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div ref={sortable.setNodeRef} style={style} className="list-item-wrap">
      <div className={`list-item${boxChecked && format === "checklist" ? " done" : ""}`}>
        {!readonly && (
          <button className="drag-handle" {...sortable.attributes} {...sortable.listeners} title="Drag to reorder">
            <GripVertical size={15} />
          </button>
        )}

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

        {isText ? (
          <span
            className="li-text li-text-static li-md"
            onClick={() => setExpanded(true)}
            dangerouslySetInnerHTML={{
              __html: oneLineHtml(props, content) || '<span class="li-empty">Empty note</span>',
            }}
          />
        ) : !expanded ? (
          <input
            className="li-text"
            value={String(props.title ?? "")}
            placeholder={type?.name}
            onChange={(e) => debouncedText(e.target.value)}
          />
        ) : (
          <span className="li-text li-text-static" onClick={() => setExpanded(true)}>
            {oneLineText(props) || type?.name || "Item"}
          </span>
        )}

        {hasMore && (
          <button
            className="icon-btn li-expand"
            title={expanded ? "Collapse" : "Expand"}
            onClick={() => setExpanded((x) => !x)}
          >
            {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>
        )}
        {!readonly && (
          <button className="icon-btn li-remove" title="Remove" onClick={() => onRemove(member.id)}>
            <X size={14} />
          </button>
        )}
      </div>

      {expanded && (
        <div className="list-item-expanded">
          {!fullBlock ? (
            <div className="hint">Loading…</div>
          ) : isText ? (
            <TextBlockEditor block={fullBlock} type={type} onConflict={reloadFull} onDeleted={() => onRemove(member.id)} />
          ) : (
            <TypedBlockCard block={fullBlock} type={type!} onConflict={reloadFull} onDeleted={() => onRemove(member.id)} />
          )}
        </div>
      )}
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
  const { slotEl, setTitle, setHasContent } = usePanels();
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
  const membershipMode = (collection?.properties.membership_mode as string) ?? "explicit";
  const smartMode = (collection?.properties.smart_mode as string) ?? "dynamic";
  const isSmart = membershipMode === "smart";
  const isDynamic = isSmart && smartMode === "dynamic";
  const isDocument = collection?.collectionKind === "document";
  const filterQuery: unknown = collection?.properties.filter_query;

  // Reorder a member (manual list order), persisted as membership order.
  const moveMember = (activeId: string, overId: string) => {
    if (isDynamic) return;
    const oldI = members.findIndex((m) => m.id === activeId);
    const newI = members.findIndex((m) => m.id === overId);
    if (oldI < 0 || newI < 0) return;
    const arr = arrayMove(members, oldI, newI);
    setMembers(arr);
    const afterId = arr[newI - 1]?.id ?? null;
    const beforeId = arr[newI + 1]?.id ?? null;
    void api.patch(`/collections/${id}/members/${activeId}`, { afterId, beforeId });
  };

  // Same sort/manual toolbar as All blocks. Manual order = membership order
  // (drag), so it's offered on every list except dynamic smart ones.
  const { sorted, toolbar: sortBar, active: sortActive } = useBlockView(members, types, {
    enableView: false,
    manual: isDynamic ? null : { onMove: moveMember },
  });

  const refresh = async () => {
    await api.post(`/collections/${id}/materialize`);
    await load();
  };

  // Right panel: query editor for smart collections and/or the section tool for
  // documents.
  useEffect(() => {
    if (!isSmart && !isDocument) {
      setHasContent(false);
      return;
    }
    setHasContent(true);
    setTitle(isDocument ? "Sections" : "Query");
    return () => {
      setHasContent(false);
    };
  }, [isSmart, isDocument, setHasContent, setTitle]);

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
    if (isDynamic || sortActive) return;
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    moveMember(String(active.id), String(over.id));
  };

  const ordered = [...types].sort((a, b) =>
    a.isText === b.isText ? a.name.localeCompare(b.name) : a.isText ? -1 : 1,
  );

  // Document sections operate directly on membership order.
  const addMember = async (blockId: string) => {
    await api.post(`/collections/${id}/members`, { blockId });
    await load();
  };
  const onSectionMove = (activeId: string, overId: string) => {
    if (isDynamic) return;
    const oldI = members.findIndex((m) => m.id === activeId);
    const newI = members.findIndex((m) => m.id === overId);
    if (oldI < 0 || newI < 0) return;
    const arr = arrayMove(members, oldI, newI);
    setMembers(arr);
    const afterId = arr[newI - 1]?.id ?? null;
    const beforeId = arr[newI + 1]?.id ?? null;
    void api.patch(`/collections/${id}/members/${activeId}`, { afterId, beforeId });
  };
  const docEntries: SectionEntry[] = members.map((m) => ({
    id: m.id,
    label:
      oneLineText(m.properties, m.content) ||
      (m.blockTypeId ? typeById.get(m.blockTypeId)?.name : undefined) ||
      "Item",
    removable: true,
  }));

  if (loading) return <div className="hint">Loading…</div>;
  if (!collection) return <div className="hint">Collection not found.</div>;

  return (
    <>
      <button className="ghost back-link" onClick={() => nav("/collections")}>
        <ArrowLeft size={16} />
        Collections
      </button>
      <input
        className="collection-title"
        value={titleVal}
        placeholder="Untitled list"
        onChange={(e) => saveTitle(e.target.value)}
      />

      <div className="row" style={{ margin: "14px 0 18px", gap: 14 }}>
        {!isDocument && (
          <div className="segmented">
            {(["bullet", "ordered", "checklist", "blocks"] as Format[]).map((f) => (
              <button
                key={f}
                className={`seg${format === f ? " active" : ""}`}
                onClick={() => setFormat(f)}
              >
                {f}
              </button>
            ))}
          </div>
        )}
        {!isDynamic && (
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
        )}

        {isSmart && (
          <>
            <span className="pill">{isDynamic ? "Smart · dynamic" : "Smart · snapshot"}</span>
            {!isDynamic && (
              <button className="ghost" onClick={() => void refresh()}>
                Refresh from query
              </button>
            )}
          </>
        )}
      </div>

      {!isDocument && members.length > 0 && sortBar}

      {members.length === 0 ? (
        <div className="hint">{isDocument ? "Empty document. Add a section." : "Empty list. Add an item."}</div>
      ) : isDocument ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={(e) => {
            const { active, over } = e;
            if (over && active.id !== over.id) onSectionMove(String(active.id), String(over.id));
          }}
        >
          <SortableContext items={members.map((m) => m.id)} strategy={verticalListSortingStrategy}>
            <div className="doc-sections">
              {members.map((m) => (
                <DocSection key={m.id} id={m.id} draggable={!isDynamic}>
                  {m.collectionKind ? (
                    <CollectionSection collectionId={m.id} types={types} />
                  ) : (
                    <BlockCard
                      block={m as unknown as Block}
                      type={m.blockTypeId ? typeById.get(m.blockTypeId) : undefined}
                      onConflict={() => void load()}
                      onDeleted={onRemove}
                    />
                  )}
                </DocSection>
              ))}
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={sorted.map((m) => m.id)} strategy={verticalListSortingStrategy}>
            <div className="list-items">
              {sorted.map((m, i) => (
                <ListItem
                  key={m.id}
                  member={m}
                  type={m.blockTypeId ? typeById.get(m.blockTypeId) : undefined}
                  index={i}
                  format={format}
                  syncStatus={syncStatus}
                  collectionId={id}
                  onRemove={onRemove}
                  readonly={isDynamic || sortActive}
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
      {slotEl &&
        (isDocument || isSmart) &&
        createPortal(
          <>
            {isSmart && (
              <QueryPanel
                key={id}
                collectionId={id}
                initial={filterQuery}
                onSaved={() => void load()}
              />
            )}
            {isDocument && (
              <>
                {isSmart && <div className="panel-divider" />}
                {isSmart && <div className="panel-h">Sections</div>}
                <SectionLayout
                  entries={docEntries}
                  canReorder={!isDynamic}
                  canModify={!isDynamic}
                  onMove={onSectionMove}
                  onRemove={onRemove}
                  onAddCollection={(cid) => void addMember(cid)}
                  onAddNote={(bid) => void addMember(bid)}
                />
              </>
            )}
          </>,
          slotEl,
        )}
    </>
  );
}
