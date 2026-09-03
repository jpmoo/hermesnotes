import type { FilterGroup } from "@hermes/shared";
import { Archive, ChevronDown, ChevronRight, Search, Trash2, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { api, type Block, type BlockType, type Collection, type Settings } from "../api.ts";
import { Banner, BannerAddButton, type BannerValue } from "../components/Banner.tsx";
import { BlockCard } from "../components/BlockCard.tsx";
import { CollapsedRow } from "../components/CollapsedRow.tsx";
import { ConfirmDialog, MembersChoice } from "../components/ConfirmDialog.tsx";
import { CollapseAllButton, useCollapse } from "../components/CollapsibleCard.tsx";
import { QueryBuilder } from "../components/QueryBuilder.tsx";
import { useBlockDeleted } from "../lib/block-events.ts";
import { emptyGroup } from "../lib/filter.ts";
import { usePanels } from "../lib/right-panel.tsx";
import { usePreferences } from "../lib/preferences.tsx";
import { useBlockView } from "../lib/useBlockView.tsx";

/**
 * The Archive: an All-blocks page over archived blocks AND collections. Cards offer
 * Unarchive (restore in place) and permanent Delete (with confirmation). This is
 * the ONLY place a block can be hard-deleted.
 */
export function ArchivePage() {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [types, setTypes] = useState<BlockType[]>([]);
  // Collections are archivable too, and a card built for a block can't represent
  // one — so they get their own list with the same two actions.
  const [archivedCollections, setArchivedCollections] = useState<Collection[]>([]);
  const [pendingCollection, setPendingCollection] = useState<Collection | null>(null);
  /** A collection being brought back, and whether its blocks come with it.
   *  The Archive is where somebody undoes an import, so the choice belongs
   *  here more than anywhere. */
  const [restoring, setRestoring] = useState<Collection | null>(null);
  const [restoreMembers, setRestoreMembers] = useState(false);
  const [search, setSearch] = useState("");
  // Similarity floor for the search box's semantic pass — matches global search.
  const [simFloor, setSimFloor] = useState(0.75);
  const [tags, setTags] = useState<string[]>([]);
  const [filter, setFilter] = useState<FilterGroup>(emptyGroup());
  const [loading, setLoading] = useState(true);
  const { bottomSlotEl, setHasContent, selectPage } = usePanels();
  const { banner, setBanner } = usePreferences();

  const typeById = new Map(types.map((t) => [t.id, t]));

  // The search box ANDs a (keyword OR semantic) match onto the builder's filter,
  // exactly as All blocks does — so a name you half-remember still finds the thing.
  const term = search.trim();
  const effectiveFilter: FilterGroup = term
    ? {
        kind: "group",
        match: "all",
        items: [
          ...filter.items,
          {
            kind: "group",
            match: "any",
            items: [
              { kind: "text", value: term },
              { kind: "semantic", value: term, floor: simFloor },
            ],
          },
        ],
      }
    : filter;

  // Collections aren't part of the block query, so their names are matched here.
  const shownCollections = term
    ? archivedCollections.filter((c) =>
        String(c.properties?.title ?? "").toLowerCase().includes(term.toLowerCase()),
      )
    : archivedCollections;
  // Archive/unarchive/delete all fire the delete event to drop the card here.
  useBlockDeleted((bid) => setBlocks((prev) => prev.filter((b) => b.id !== bid)));

  useEffect(() => {
    void api.get<Collection[]>("/collections/archived").then(setArchivedCollections).catch(() => {});
    void api
      .get<Settings>("/settings")
      .then((st) => setSimFloor(st.defaultSimilarity ?? 0.75))
      .catch(() => {});
    void api.get<BlockType[]>("/block-types").then(setTypes);
    void api.get<{ name: string }[]>("/tags").then((t) => setTags(t.map((x) => x.name)));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      void api
        .post<Block[]>("/blocks/query", { filterQuery: effectiveFilter, archived: true })
        .then(setBlocks)
        .finally(() => setLoading(false));
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, search, simFloor]);

  useEffect(() => {
    setHasContent(true);
    selectPage("archive");
    return () => setHasContent(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setHasContent]);

  const onDeleted = (id: string) => setBlocks((prev) => prev.filter((b) => b.id !== id));

  // Emptying the Archive is the one action here with nothing behind it, so it
  // asks twice: once for the intent, and once with the word typed out. The
  // second isn't a repeat of the first — it's the step that makes the hand stop.
  const [emptyStage, setEmptyStage] = useState<0 | 1 | 2>(0);
  const [emptying, setEmptying] = useState(false);
  const archivedCount = blocks.length + archivedCollections.length;
  const emptyArchive = async () => {
    setEmptying(true);
    try {
      await api.post<{ deleted: number }>("/archive/empty", {});
      setBlocks([]);
      setArchivedCollections([]);
      setEmptyStage(0);
    } finally {
      setEmptying(false);
    }
  };
  const reload = () =>
    void api.post<Block[]>("/blocks/query", { filterQuery: effectiveFilter, archived: true }).then(setBlocks);

  const { renderToolbar, renderList, viewMode, sortFields } = useBlockView(blocks, types, {
    scope: "archive",
  });

  const { collapsed, toggle: toggleCard, allCollapsed, toggleAll } = useCollapse(
    blocks.map((b) => b.id),
    "archive",
  );

  return (
    <>
      {(banner("archive") as BannerValue | null) && (
        <Banner value={banner("archive") as BannerValue} editable onChange={(v) => setBanner("archive", v)} />
      )}
      <div className="page-head">
        <h1 className="page-title title-with-icon">
          <Archive size={22} color="#26282b" />
          Archive
        </h1>
        {!banner("archive") && (
          <BannerAddButton className="page-head-add" onAdded={(v) => setBanner("archive", v)} />
        )}
      </div>
      <p className="page-sub">
        Archived blocks and collections — hidden from every normal view. Unarchive to restore in
        place, or delete permanently (only here).
      </p>

      <div className="row" style={{ marginBottom: 14, gap: 12 }}>
        {archivedCount > 0 && (
          <button
            className="ghost archive-empty"
            style={{ marginLeft: "auto" }}
            disabled={emptying}
            onClick={() => setEmptyStage(1)}
          >
            <Trash2 size={14} /> {emptying ? "Deleting…" : "Delete all"}
          </button>
        )}
        <span className="hint">
          {blocks.length} block(s)
          {shownCollections.length > 0 && ` · ${shownCollections.length} collection(s)`}
          {term && " matching"}
        </span>
      </div>

      <div className="allblocks-search">
        <Search size={16} className="allblocks-search-icon" />
        <input
          className="allblocks-search-input"
          placeholder="Search the archive by name (keyword + similar)…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search && (
          <button className="icon-btn" title="Clear search" onClick={() => setSearch("")}>
            <X size={14} />
          </button>
        )}
      </div>

      {shownCollections.length > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="panel-h">Archived collections</div>
          {shownCollections.map((c) => (
            <div className="row archived-collection" key={c.id}>
              <span className="archived-collection-name">
                {String(c.properties?.title ?? "Untitled")}
                <span className="hint">
                  {" "}
                  · {c.collectionKind === "document" ? "spread" : c.collectionKind}
                </span>
              </span>
              <button
                className="ghost"
                onClick={() => {
                  setRestoreMembers(false);
                  setRestoring(c);
                }}
              >
                Unarchive
              </button>
              <button className="danger" onClick={() => setPendingCollection(c)}>
                Delete
              </button>
            </div>
          ))}
        </div>
      )}

      {blocks.length > 0 &&
        renderToolbar(
          viewMode !== "chips" && (
            <CollapseAllButton allCollapsed={allCollapsed} onToggle={toggleAll} />
          ),
        )}

      {loading ? (
        <div className="hint">Loading…</div>
      ) : blocks.length === 0 ? (
        <div className="hint">
          {term
            ? "Nothing in the archive matches that."
            : shownCollections.length > 0
              ? "No archived blocks — just the collections above."
              : "Nothing archived."}
        </div>
      ) : (
        renderList((b, compact) => {
          const col = collapsed.has(b.id);
          return (
            <div className="bv-card-wrap">
              <button
                className="icon-btn card-collapse"
                title={col ? "Expand" : "Collapse"}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleCard(b.id);
                }}
              >
                {col ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              </button>
              {col ? (
                <CollapsedRow block={b} type={typeById.get(b.blockTypeId)} fields={sortFields} />
              ) : (
                <BlockCard
                  block={b}
                  type={typeById.get(b.blockTypeId)}
                  onConflict={reload}
                  onDeleted={onDeleted}
                  compact={compact}
                  archived
                />
              )}
            </div>
          );
        })
      )}

      <ConfirmDialog
        open={restoring !== null}
        title={`Unarchive “${String(restoring?.properties?.title ?? "Untitled")}”?`}
        message={
          restoreMembers
            ? "The collection comes back, and so does everything that went into the Archive with it."
            : "The collection comes back. Blocks archived alongside it stay here."
        }
        confirmLabel={restoreMembers ? "Unarchive it and its blocks" : "Unarchive"}
        danger={false}
        onCancel={() => setRestoring(null)}
        onConfirm={() => {
          const c = restoring;
          setRestoring(null);
          if (!c) return;
          void api
            .post(`/blocks/${c.id}/unarchive`, { members: restoreMembers })
            .then(() => api.get<Collection[]>("/collections/archived").then(setArchivedCollections))
            .then(() => reload())
            .catch(() => {});
        }}
      >
        {restoring && restoring.properties?.membership_mode !== "smart" && (
          <MembersChoice
            action="unarchive"
            checked={restoreMembers}
            onChange={setRestoreMembers}
          />
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={pendingCollection !== null}
        title={`Delete “${String(pendingCollection?.properties?.title ?? "Untitled")}”?`}
        message="This permanently removes the collection. Blocks that aren't in any other collection become Unattached. This can't be undone."
        confirmLabel="Delete"
        onCancel={() => setPendingCollection(null)}
        onConfirm={() => {
          const target = pendingCollection;
          setPendingCollection(null);
          if (!target) return;
          void api
            .del(`/collections/${target.id}`)
            .then(() => api.get<Collection[]>("/collections/archived").then(setArchivedCollections))
            .catch(() => {});
        }}
      />

      {bottomSlotEl &&
        createPortal(
          <>
            <div className="panel-divider" />
            <div className="panel-h">Filter</div>
            <QueryBuilder value={filter} onChange={setFilter} types={types} tags={tags} archived />
          </>,
          bottomSlotEl,
        )}
      <ConfirmDialog
        open={emptyStage === 1}
        title="Delete everything in the Archive?"
        message={`${blocks.length} block(s)${
          archivedCollections.length ? ` and ${archivedCollections.length} collection(s)` : ""
        } will be permanently deleted. Unarchiving is no longer an option afterwards, and there's no undo.`}
        confirmLabel="Continue"
        onCancel={() => setEmptyStage(0)}
        onConfirm={() => setEmptyStage(2)}
      />
      <ConfirmDialog
        open={emptyStage === 2}
        title={`Permanently delete ${archivedCount} item(s)`}
        message="This cannot be undone. Blocks that other blocks refer to will leave those references pointing at nothing."
        requireText="delete"
        confirmLabel="Delete permanently"
        onCancel={() => setEmptyStage(0)}
        onConfirm={() => void emptyArchive()}
      />
    </>
  );
}
