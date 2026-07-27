import type { FilterGroup } from "@hermes/shared";
import { Archive, ChevronDown, ChevronUp } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { api, type Block, type BlockType } from "../api.ts";
import { Banner, BannerAddButton, type BannerValue } from "../components/Banner.tsx";
import { BlockCard } from "../components/BlockCard.tsx";
import { CollapsedRow } from "../components/CollapsedRow.tsx";
import { useCollapse } from "../components/CollapsibleCard.tsx";
import { QueryBuilder } from "../components/QueryBuilder.tsx";
import { useBlockDeleted } from "../lib/block-events.ts";
import { emptyGroup } from "../lib/filter.ts";
import { usePanels } from "../lib/right-panel.tsx";
import { usePreferences } from "../lib/preferences.tsx";
import { useBlockView } from "../lib/useBlockView.tsx";

/**
 * The Archive: an All-blocks page over archived items only. Cards offer
 * Unarchive (restore in place) and permanent Delete (with confirmation). This is
 * the ONLY place a block can be hard-deleted.
 */
export function ArchivePage() {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [types, setTypes] = useState<BlockType[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [filter, setFilter] = useState<FilterGroup>(emptyGroup());
  const [loading, setLoading] = useState(true);
  const { bottomSlotEl, setHasContent, selectPage } = usePanels();
  const { banner, setBanner } = usePreferences();

  const typeById = new Map(types.map((t) => [t.id, t]));
  // Archive/unarchive/delete all fire the delete event to drop the card here.
  useBlockDeleted((bid) => setBlocks((prev) => prev.filter((b) => b.id !== bid)));

  useEffect(() => {
    void api.get<BlockType[]>("/block-types").then(setTypes);
    void api.get<{ name: string }[]>("/tags").then((t) => setTags(t.map((x) => x.name)));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      void api
        .post<Block[]>("/blocks/query", { filterQuery: filter, archived: true })
        .then(setBlocks)
        .finally(() => setLoading(false));
    }, 300);
    return () => clearTimeout(t);
  }, [filter]);

  useEffect(() => {
    setHasContent(true);
    selectPage("archive");
    return () => setHasContent(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setHasContent]);

  const onDeleted = (id: string) => setBlocks((prev) => prev.filter((b) => b.id !== id));
  const reload = () =>
    void api.post<Block[]>("/blocks/query", { filterQuery: filter, archived: true }).then(setBlocks);

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
        Archived blocks — hidden from every normal view. Unarchive to restore in place, or delete
        permanently (only here).
      </p>

      <div className="row" style={{ marginBottom: 14, gap: 12 }}>
        {viewMode !== "chips" && blocks.length > 0 && (
          <button className="ghost" onClick={toggleAll}>
            {allCollapsed ? "Expand all" : "Collapse all"}
          </button>
        )}
        <span className="hint">{blocks.length} archived block(s)</span>
      </div>

      {blocks.length > 0 && toolbar}

      {loading ? (
        <div className="hint">Loading…</div>
      ) : blocks.length === 0 ? (
        <div className="hint">Nothing archived.</div>
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
