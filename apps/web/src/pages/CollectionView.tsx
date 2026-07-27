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
import { GripVertical, RefreshCw, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, type Block, type BlockType, type Collection, type Member } from "../api.ts";
import { BlockIcon } from "../lib/icons.tsx";
import { oneLineText } from "../lib/display.ts";
import { Banner, BannerAddButton, type BannerValue } from "../components/Banner.tsx";
import { FinderModal } from "../components/FinderModal.tsx";
import { CalendarView } from "../components/CalendarView.tsx";
import { CanvasView } from "../components/CanvasView.tsx";
import { MatrixView } from "../components/MatrixView.tsx";
import { NewItemModal } from "../components/NewItemModal.tsx";
import { BlockCard } from "../components/BlockCard.tsx";
import { CollectionSection } from "../components/CollectionSection.tsx";
import { ListItem, type ListFormat as Format } from "../components/ListItem.tsx";
import { QueryPanel } from "../components/QueryPanel.tsx";
import { SectionLayout, type SectionEntry } from "../components/SectionLayout.tsx";
import { TableView } from "../components/TableView.tsx";
import { useAnyBlockChange, useBlockDeleted } from "../lib/block-events.ts";
import { usePanels } from "../lib/right-panel.tsx";
import { useSetRouteBanner } from "../lib/route-banner.tsx";
import { useBlockView, type BlockViewState } from "../lib/useBlockView.tsx";

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
  const [expandSignal, setExpandSignal] = useState<{ open: boolean; nonce: number }>();
  const [allExpanded, setAllExpanded] = useState(false);
  const [titleVal, setTitleVal] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const { bottomSlotEl, setHasContent, selectBlock, selectedBlockId } = usePanels();
  const titleTimer = useRef<ReturnType<typeof setTimeout>>();

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const typeById = new Map(types.map((t) => [t.id, t]));

  // A deletion anywhere (e.g. the info panel) drops the member immediately.
  useBlockDeleted((bid) => setMembers((m) => m.filter((x) => x.id !== bid)));

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

  // Populate the info block with this collection on arrival (e.g. from the
  // collections menu). Skip if it's already selected — arriving via the info
  // block already set it, and we don't want to clobber that history. Runs on id
  // change only, so opening a member's info doesn't snap back to the collection.
  const selRef = useRef(selectedBlockId);
  selRef.current = selectedBlockId;
  useEffect(() => {
    if (id && selRef.current !== id) selectBlock(id, { collection: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const isMatrix = collection?.collectionKind === "matrix";
  const isTable = collection?.collectionKind === "table";
  const isCanvas = collection?.collectionKind === "canvas";
  const isCalendar = collection?.collectionKind === "calendar";
  const filterQuery: unknown = collection?.properties.filter_query;

  // An edit anywhere (e.g. the info pane) can move a block in/out of a live
  // query, so re-run it. Dynamic smart lists + matrices re-evaluate; snapshots
  // stay frozen until an explicit refresh. Debounced against rapid typing.
  const reloadTimer = useRef<ReturnType<typeof setTimeout>>();
  useAnyBlockChange(() => {
    if (!(isDynamic || isMatrix)) return;
    clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => void load(), 350);
  });

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
  // Blocks format gets the full Block/Masonry/Chips view toggle; the one-line
  // formats keep their row rendering (a view toggle makes no sense there).
  // Canonical view state lives on the collection; embeds inherit it and fork
  // on their first change (see CollectionSection).
  const vsTimer = useRef<ReturnType<typeof setTimeout>>();
  const { sorted, toolbar: sortBar, active: sortActive, renderList } = useBlockView(members, types, {
    enableView: format === "blocks",
    manual: isDynamic ? null : { onMove: moveMember },
    viewState: {
      initial: (collection?.properties.view_state as BlockViewState | undefined) ?? undefined,
      onChange: (vs) => {
        if (vsTimer.current) clearTimeout(vsTimer.current);
        vsTimer.current = setTimeout(() => void api.patch(`/collections/${id}`, { view_state: vs }), 600);
      },
    },
  });

  // One refresh affordance for every smart collection: snapshots re-materialize
  // from the query; dynamic (and matrix) just re-run it via a reload.
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      if (isSmart && !isDynamic && !isMatrix) await api.post(`/collections/${id}/materialize`);
      await load();
    } finally {
      setRefreshing(false);
    }
  };
  // The Smart pill + refresh: shown in the header for most kinds, but folded into
  // the matrix's own dims row so a matrix keeps a single toolbar line.
  const smartControls = (
    <>
      <span className="pill">{isMatrix ? "Smart" : isDynamic ? "Smart · dynamic" : "Smart · snapshot"}</span>
      <button
        className="icon-btn"
        title={!isDynamic && !isMatrix ? "Refresh from query" : "Re-run the query"}
        disabled={refreshing}
        onClick={() => void refresh()}
      >
        <RefreshCw size={15} className={refreshing ? "hn-spin" : undefined} />
      </button>
    </>
  );

  // Right panel: query editor for smart collections (and canvases — their
  // query feeds the field), the section tool for documents, table tools.
  useEffect(() => {
    if (!isSmart && !isDocument && !isTable && !isCanvas && !isCalendar) {
      setHasContent(false);
      return;
    }
    setHasContent(true);
    return () => {
      setHasContent(false);
    };
  }, [isSmart, isDocument, isTable, isCanvas, isCalendar, setHasContent]);

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

  // Reflect an inline edit into the member list so the current sort re-runs
  // (only reorders visibly when a property sort is active).
  const onMemberChange = (
    blockId: string,
    patch: { properties?: Record<string, unknown>; content?: string | null },
  ) => setMembers((m) => m.map((x) => (x.id === blockId ? { ...x, ...patch } : x)));

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

  useSetRouteBanner(collection ? (collection.properties as Record<string, unknown>).banner : null);

  if (loading) return <div className="hint">Loading…</div>;
  if (!collection) return <div className="hint">Collection not found.</div>;

  const banner = (collection.properties.banner as BannerValue | null) ?? null;
  const setBanner = (v: BannerValue | null) => {
    setCollection((c) => (c ? { ...c, properties: { ...c.properties, banner: v ?? undefined } } : c));
    void api.patch(`/collections/${id}`, { banner: v ?? null });
  };

  return (
    <>
      {banner && <Banner value={banner} editable onChange={setBanner} />}
      <div className="collection-head">
        <input
          className="collection-title"
          value={titleVal}
          placeholder="Untitled list"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          data-1p-ignore="true"
          data-lpignore="true"
          onFocus={() => selectBlock(id, { collection: true })}
          onChange={(e) => saveTitle(e.target.value)}
        />
        {!banner && <BannerAddButton className="page-head-add" onAdded={setBanner} />}
      </div>

      {!isMatrix && (
      <div className="row" style={{ margin: "14px 0 18px", gap: 14 }}>
        {!isDocument && !isMatrix && !isTable && !isCanvas && !isCalendar && (
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
        {!isDynamic && !isMatrix && !isCanvas && !isCalendar && (
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
                {/* Canvas creates via ephemeral notes (double-click), not here. */}
                {!isCanvas && <div className="menu-sep" />}
                {!isCanvas && ordered.map((t) => (
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

        {isSmart && !isMatrix && smartControls}

        {!isDocument && !isMatrix && !isTable && !isCanvas && !isCalendar && format !== "blocks" && members.length > 0 && (
          <button
            className="ghost"
            style={{ marginLeft: "auto" }}
            onClick={() => {
              const open = !allExpanded;
              setAllExpanded(open);
              setExpandSignal((s) => ({ open, nonce: (s?.nonce ?? 0) + 1 }));
            }}
          >
            {allExpanded ? "Collapse all" : "Expand all"}
          </button>
        )}
      </div>
      )}

      {!isDocument && !isMatrix && !isTable && !isCanvas && !isCalendar && members.length > 0 && sortBar}

      {isMatrix ? (
        <MatrixView
          collection={collection}
          members={members}
          types={types}
          onChanged={() => void load()}
          header={isSmart ? smartControls : undefined}
        />
      ) : isCalendar ? (
        <CalendarView collection={collection} members={members} types={types} onChanged={() => void load()} />
      ) : isCanvas ? (
        <div className="canvas-area">
          <CanvasView collection={collection} members={members} types={types} onChanged={() => void load()} />
        </div>
      ) : isTable ? (
        <TableView
          collection={collection}
          members={members}
          types={types}
          onChanged={() => void load()}
          onMemberChange={onMemberChange}
        />
      ) : members.length === 0 ? (
        <div className="hint">{isDocument ? "Empty spread. Add a section." : "Empty list. Add an item."}</div>
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
                    <CollectionSection collectionId={m.id} types={types} host={id} />
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
      ) : format === "blocks" ? (
        renderList((m, compact) => (
          <div className={compact ? undefined : "bv-card-wrap"}>
            {!compact && !isDynamic && (
              <button
                className="icon-btn card-collapse"
                title="Remove from list"
                onClick={() => onRemove(m.id)}
              >
                <X size={14} />
              </button>
            )}
            <BlockCard
              block={m as unknown as Block}
              type={m.blockTypeId ? typeById.get(m.blockTypeId) : undefined}
              onConflict={() => void load()}
              onDeleted={onRemove}
              compact={compact}
            />
          </div>
        ))
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
                  onMemberChange={onMemberChange}
                  readonly={isDynamic || sortActive}
                  expandSignal={expandSignal}
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
      {bottomSlotEl &&
        (isDocument || isSmart) &&
        selectedBlockId === id &&
        createPortal(
          <>
            <div className="panel-divider" />
            {isSmart && (
              <>
                <div className="panel-h">Query</div>
                <QueryPanel
                  key={id}
                  collectionId={id}
                  initial={filterQuery}
                  onSaved={() => void load()}
                />
              </>
            )}
            {isDocument && (
              <>
                {isSmart && <div className="panel-divider" />}
                <div className="panel-h">Sections</div>
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
          bottomSlotEl,
        )}
    </>
  );
}
