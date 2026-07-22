import { ChevronDown, ChevronUp, Star } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type Block, type BlockType } from "../api.ts";
import { BlockCard } from "../components/BlockCard.tsx";
import { oneLineText } from "../lib/display.ts";
import { CollectionIcon } from "../lib/icons.tsx";
import { usePanels } from "../lib/right-panel.tsx";
import { usePreferences } from "../lib/preferences.tsx";
import { useBlockView } from "../lib/useBlockView.tsx";

/**
 * Starred blocks and collections. Same sort/view controls as All blocks
 * (block list / masonry, per-card collapse); collections are listed on top
 * as open-able rows.
 */
export function FavoritesPage() {
  const { favorites } = usePreferences();
  const { openBlock } = usePanels();
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [types, setTypes] = useState<BlockType[]>([]);
  const [loading, setLoading] = useState(true);
  const typeById = new Map(types.map((t) => [t.id, t]));

  useEffect(() => {
    void api.get<BlockType[]>("/block-types").then(setTypes).catch(() => {});
  }, []);

  const favKey = favorites.join(",");
  useEffect(() => {
    let alive = true;
    setLoading(true);
    void Promise.all(
      favorites.map((id) => api.get<Block>(`/blocks/${id}`).catch(() => null)),
    )
      .then((rs) => {
        if (alive) setBlocks(rs.filter((b): b is Block => b !== null));
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [favKey]);

  const collections = blocks.filter((b) => b.collectionKind);
  const plain = blocks.filter((b) => !b.collectionKind);

  const reload = () => {
    void Promise.all(favorites.map((id) => api.get<Block>(`/blocks/${id}`).catch(() => null))).then(
      (rs) => setBlocks(rs.filter((b): b is Block => b !== null)),
    );
  };

  const { toolbar, renderList } = useBlockView(plain, types, { scope: "favorites" });

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const allCollapsed = plain.length > 0 && plain.every((b) => collapsed.has(b.id));
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
        <Star size={22} color="#26282b" />
        Favorites
      </h1>
      <p className="page-sub">Starred blocks and collections (star them in the info panel).</p>

      {collections.length > 0 && (
        <div className="fav-collections">
          {collections.map((c) => (
            <button
              key={c.id}
              className="sec-sublink fav-collection"
              onClick={() => openBlock(c.id, { collection: true })}
            >
              <CollectionIcon
                document={c.collectionKind === "document"}
                matrix={c.collectionKind === "matrix"}
                smart={(c.properties as Record<string, unknown>)?.membership_mode === "smart"}
                size={15}
              />
              {oneLineText(c.properties) || "Untitled collection"}
            </button>
          ))}
        </div>
      )}

      {plain.length > 0 && (
        <div className="row" style={{ marginBottom: 10, gap: 12 }}>
          {toolbar}
          <button
            className="ghost"
            onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(plain.map((b) => b.id)))}
          >
            {allCollapsed ? "Expand all" : "Collapse all"}
          </button>
        </div>
      )}

      {loading ? (
        <div className="hint">Loading…</div>
      ) : blocks.length === 0 ? (
        <div className="hint">Nothing starred yet — use the ★ in the info panel.</div>
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
              onDeleted={reload}
              compact={compact || collapsed.has(b.id)}
            />
          </div>
        ))
      )}
    </>
  );
}
