import type { FilterGroup } from "@hermes/shared";
import { Archive, ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { api, type Block, type BlockType, type Collection, type Settings } from "../api.ts";
import { Banner, BannerAddButton, type BannerValue } from "../components/Banner.tsx";
import { BlockCard } from "../components/BlockCard.tsx";
import { CollapsedRow } from "../components/CollapsedRow.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { useCollapse } from "../components/CollapsibleCard.tsx";
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
  const reload = () =>
    void api.post<Block[]>("/blocks/query", { filterQuery: effectiveFilter, archived: true }).then(setBlocks);

  const { toolbar, renderList, viewMode } = useBlockView(blocks, types, { scope: "archive" });

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
        {viewMode !== "chips" && blocks.length > 0 && (
          <button className="ghost" onClick={toggleAll}>
            {allCollapsed ? "Expand all" : "Collapse all"}
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
                onClick={() =>
                  void api
                    .post(`/blocks/${c.id}/unarchive`, {})
                    .then(() =>
                      api.get<Collection[]>("/collections/archived").then(setArchivedCollections),
                    )
                    .catch(() => {})
                }
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

      {blocks.length > 0 && toolbar}

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
                {col ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
              </button>
              {col ? (
                <CollapsedRow block={b} type={typeById.get(b.blockTypeId)} />
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
            <QueryBuilder value={filter} onChange={setFilter} types={types} tags={tags} />
          </>,
          bottomSlotEl,
        )}
    </>
  );
}
