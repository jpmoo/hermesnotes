import type { FilterGroup } from "@hermes/shared";
import { ChevronDown, ChevronRight, FolderPlus, Layers, Search, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { api, type Block, type BlockType, type Settings } from "../api.ts";
import { Banner, BannerAddButton, type BannerValue } from "../components/Banner.tsx";
import { BlockCard } from "../components/BlockCard.tsx";
import { CollapsedRow } from "../components/CollapsedRow.tsx";
import { CollapseAllButton, useCollapse } from "../components/CollapsibleCard.tsx";
import { QueryBuilder } from "../components/QueryBuilder.tsx";
import { SaveAsCollectionModal } from "../components/SaveAsCollectionModal.tsx";
import { useBlockDeleted } from "../lib/block-events.ts";
import { emptyGroup } from "../lib/filter.ts";
import { usePanels } from "../lib/right-panel.tsx";
import { usePreferences } from "../lib/preferences.tsx";
import { useBlockView } from "../lib/useBlockView.tsx";

export function AllBlocksPage() {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [types, setTypes] = useState<BlockType[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [filter, setFilter] = useState<FilterGroup>(emptyGroup());
  const [search, setSearch] = useState("");
  // Similarity floor for the search box's semantic pass — matches global search.
  const [simFloor, setSimFloor] = useState(0.75);
  const [loading, setLoading] = useState(true);
  const [saveOpen, setSaveOpen] = useState(false);
  const { bottomSlotEl, setHasContent, selectPage } = usePanels();
  const { banner, setBanner } = usePreferences();

  const typeById = new Map(types.map((t) => [t.id, t]));
  useBlockDeleted((bid) => setBlocks((prev) => prev.filter((b) => b.id !== bid)));

  useEffect(() => {
    void api.get<BlockType[]>("/block-types").then(setTypes);
    void api.get<{ name: string }[]>("/tags").then((t) => setTags(t.map((x) => x.name)));
    void api
      .get<Settings>("/settings")
      .then((s) => setSimFloor(s.defaultSimilarity ?? 0.75))
      .catch(() => {});
  }, []);

  // The live search box ANDs a (keyword OR semantic) match onto the builder's
  // filter — so results include both literal hits and conceptually-similar ones,
  // like the global search. (Semantic is a no-op when no embedding model is set.)
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

  // Re-run the query whenever the filter or search changes (debounced).
  useEffect(() => {
    const t = setTimeout(() => {
      void api
        .post<Block[]>("/blocks/query", { filterQuery: effectiveFilter })
        .then(setBlocks)
        .finally(() => setLoading(false));
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, search, simFloor]);

  // Offer the query builder in the right panel; arriving logs the page as the
  // current location (clearing any block selection, so the panel shows tools).
  useEffect(() => {
    setHasContent(true);
    selectPage("blocks");
    return () => setHasContent(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setHasContent]);

  const onDeleted = (id: string) => setBlocks((prev) => prev.filter((b) => b.id !== id));
  const reload = () =>
    void api.post<Block[]>("/blocks/query", { filterQuery: effectiveFilter }).then(setBlocks);

  const { renderToolbar, renderList, viewMode, sortFields } = useBlockView(blocks, types, {
    scope: "allblocks",
  });

  // Per-card collapse (block view only; masonry cards are already compact),
  // persisted so the page keeps its state across navigation and reloads.
  const { collapsed, toggle: toggleCard, allCollapsed, toggleAll } = useCollapse(
    blocks.map((b) => b.id),
    "allblocks",
  );

  return (
    <>
      {(banner("blocks") as BannerValue | null) && (
        <Banner
          value={banner("blocks") as BannerValue}
          editable
          onChange={(v) => setBanner("blocks", v)}
        />
      )}
      <div className="page-head">
        <h1 className="page-title title-with-icon">
        <Layers size={22} color="#26282b" />
        All blocks
      </h1>
        {!(banner("blocks")) && (
          <BannerAddButton className="page-head-add" onAdded={(v) => setBanner("blocks", v)} />
        )}
      </div>
      <p className="page-sub">
        Every block. Search below, or filter with the query builder on the right and save it as a list.
      </p>

      <div className="allblocks-search">
        <Search size={16} className="allblocks-search-icon" />
        <input
          type="text"
          placeholder="Search all blocks (keyword + similar)…"
          value={search}
          autoComplete="off"
          onChange={(e) => setSearch(e.target.value)}
        />
        {search && (
          <button className="icon-btn" title="Clear search" onClick={() => setSearch("")}>
            <X size={14} />
          </button>
        )}
      </div>

      <div className="row" style={{ marginBottom: 14, gap: 12 }}>
        <button className="save-as-btn" onClick={() => setSaveOpen(true)}>
          <FolderPlus size={15} />
          Save as collection
        </button>
        <span className="hint">{blocks.length} block(s)</span>
      </div>

      {blocks.length > 0 &&
        renderToolbar(
          viewMode !== "chips" && (
            <CollapseAllButton allCollapsed={allCollapsed} onToggle={toggleAll} />
          ),
        )}

      {loading ? (
        <div className="hint">Loading…</div>
      ) : blocks.length === 0 ? (
        <div className="hint">No blocks match this filter.</div>
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
                // Masonry keeps a small banner slice; block view is one line.
                <CollapsedRow block={b} type={typeById.get(b.blockTypeId)} fields={sortFields} />
              ) : (
                <BlockCard
                  block={b}
                  type={typeById.get(b.blockTypeId)}
                  onConflict={reload}
                  onDeleted={onDeleted}
                  compact={compact}
                />
              )}
            </div>
          );
        })
      )}

      {saveOpen && <SaveAsCollectionModal filter={effectiveFilter} onClose={() => setSaveOpen(false)} />}

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
