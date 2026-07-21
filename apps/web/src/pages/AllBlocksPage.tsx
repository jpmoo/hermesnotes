import type { FilterGroup } from "@hermes/shared";
import { Layers } from "lucide-react";
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
  const { slotEl, setTitle, setHasContent } = usePanels();

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

  // Offer the query builder in the right panel.
  useEffect(() => {
    setHasContent(true);
    setTitle("Filter");
    return () => setHasContent(false);
  }, [setHasContent, setTitle]);

  const onDeleted = (id: string) => setBlocks((prev) => prev.filter((b) => b.id !== id));
  const reload = () =>
    void api.post<Block[]>("/blocks/query", { filterQuery: filter }).then(setBlocks);

  const { toolbar, renderList } = useBlockView(blocks, types);

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
        <button className="primary" onClick={() => setSaveOpen(true)}>
          Save as collection…
        </button>
        <span className="hint">{blocks.length} block(s)</span>
      </div>

      {blocks.length > 0 && toolbar}

      {loading ? (
        <div className="hint">Loading…</div>
      ) : blocks.length === 0 ? (
        <div className="hint">No blocks match this filter.</div>
      ) : (
        renderList((b) => (
          <BlockCard
            block={b}
            type={typeById.get(b.blockTypeId)}
            onConflict={reload}
            onDeleted={onDeleted}
          />
        ))
      )}

      {saveOpen && <SaveAsCollectionModal filter={filter} onClose={() => setSaveOpen(false)} />}

      {slotEl &&
        createPortal(
          <QueryBuilder value={filter} onChange={setFilter} types={types} tags={tags} />,
          slotEl,
        )}
    </>
  );
}
