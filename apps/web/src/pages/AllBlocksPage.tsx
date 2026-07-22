import type { FilterGroup } from "@hermes/shared";
import { ChevronDown, ChevronUp, FolderPlus, Layers } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { api, type Block, type BlockType } from "../api.ts";
import { BlockCard } from "../components/BlockCard.tsx";
import { QueryBuilder } from "../components/QueryBuilder.tsx";
import { SaveAsCollectionModal } from "../components/SaveAsCollectionModal.tsx";
import { emptyGroup } from "../lib/filter.ts";
import { usePanels } from "../lib/right-panel.tsx";
import { useBlockView } from "../lib/useBlockView.tsx";

export function AllBlocksPage() {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [types, setTypes] = useState<BlockType[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [filter, setFilter] = useState<FilterGroup>(emptyGroup());
  const [loading, setLoading] = useState(true);
  const [saveOpen, setSaveOpen] = useState(false);
  const { bottomSlotEl, setHasContent, selectPage } = usePanels();

  const typeById = new Map(types.map((t) => [t.id, t]));

  useEffect(() => {
    void api.get<BlockType[]>("/block-types").then(setTypes);
    void api.get<{ name: string }[]>("/tags").then((t) => setTags(t.map((x) => x.name)));
  }, []);

  // Re-run the query whenever the filter changes (debounced).
  useEffect(() => {
    const t = setTimeout(() => {
      void api
        .post<Block[]>("/blocks/query", { filterQuery: filter })
        .then(setBlocks)
        .finally(() => setLoading(false));
    }, 300);
    return () => clearTimeout(t);
  }, [filter]);

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
    void api.post<Block[]>("/blocks/query", { filterQuery: filter }).then(setBlocks);

  const { toolbar, renderList } = useBlockView(blocks, types, { scope: "allblocks" });

  // Per-card collapse (block view only; masonry cards are already compact).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const allCollapsed = blocks.length > 0 && blocks.every((b) => collapsed.has(b.id));
  const toggleCard = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      <h1 className="page-title title-with-icon">
        <Layers size={22} color="#26282b" />
        All blocks
      </h1>
      <p className="page-sub">
        Every block. Filter with the query builder on the right, then save it as a list.
      </p>

      <div className="row" style={{ marginBottom: 14, gap: 12 }}>
        <button className="save-as-btn" onClick={() => setSaveOpen(true)}>
          <FolderPlus size={15} />
          Save as collection
        </button>
        <button
          className="ghost"
          onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(blocks.map((b) => b.id)))}
        >
          {allCollapsed ? "Expand all" : "Collapse all"}
        </button>
        <span className="hint">{blocks.length} block(s)</span>
      </div>

      {blocks.length > 0 && toolbar}

      {loading ? (
        <div className="hint">Loading…</div>
      ) : blocks.length === 0 ? (
        <div className="hint">No blocks match this filter.</div>
      ) : (
        renderList((b, compact) => (
          <div className={compact ? undefined : "bv-card-wrap"}>
            {!compact && (
              <button
                className="icon-btn card-collapse"
                title={collapsed.has(b.id) ? "Expand" : "Collapse"}
                onClick={() => toggleCard(b.id)}
              >
                {collapsed.has(b.id) ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
              </button>
            )}
            <BlockCard
              block={b}
              type={typeById.get(b.blockTypeId)}
              onConflict={reload}
              onDeleted={onDeleted}
              compact={compact || collapsed.has(b.id)}
              textCollapsed={collapsed.has(b.id)}
            />
          </div>
        ))
      )}

      {saveOpen && <SaveAsCollectionModal filter={filter} onClose={() => setSaveOpen(false)} />}

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
