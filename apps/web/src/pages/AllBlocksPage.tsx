import type { FilterGroup } from "@hermes/shared";
import { Layers } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { api, type Block, type BlockType } from "../api.ts";
import { BlockIcon } from "../lib/icons.tsx";
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
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { bottomSlotEl, setHasContent } = usePanels();

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
    return () => setHasContent(false);
  }, [setHasContent]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const create = async (t: BlockType) => {
    setMenuOpen(false);
    const block = await api.post<Block>("/blocks", { blockTypeId: t.id });
    setBlocks((prev) => [block, ...prev]);
  };

  // Text type first, then the rest alphabetically.
  const ordered = [...types].sort((a, b) =>
    a.isText === b.isText ? a.name.localeCompare(b.name) : a.isText ? -1 : 1,
  );

  const onDeleted = (id: string) => setBlocks((prev) => prev.filter((b) => b.id !== id));
  const reload = () =>
    void api.post<Block[]>("/blocks/query", { filterQuery: filter }).then(setBlocks);

  const { toolbar, renderList } = useBlockView(blocks, types, { scope: "allblocks" });

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
        <div className="nav-kebab" ref={menuRef} style={{ position: "relative" }}>
          <button className="primary" onClick={() => setMenuOpen((o) => !o)}>
            + New
          </button>
          {menuOpen && (
            <div className="menu" style={{ left: 0, right: "auto" }}>
              {ordered.map((t) => (
                <button key={t.id} className="menu-item type-item" onClick={() => void create(t)}>
                  <BlockIcon iconKey={t.isText ? "type" : t.iconKey} color={t.iconColor} size={16} />
                  <span style={{ textTransform: "capitalize" }}>{t.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="ghost" onClick={() => setSaveOpen(true)}>
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
        renderList((b, compact) => (
          <BlockCard
            block={b}
            type={typeById.get(b.blockTypeId)}
            onConflict={reload}
            onDeleted={onDeleted}
            compact={compact}
          />
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
