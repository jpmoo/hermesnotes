import { useCallback, useEffect, useState } from "react";
import { api, type Block, type BlockType } from "../api.ts";
import { useBlockDeleted } from "../lib/block-events.ts";
import { useBlockView } from "../lib/useBlockView.tsx";
import { BlockCard } from "./BlockCard.tsx";

/**
 * Blocks of a single type, newest-edited first, with a dynamic search box
 * (title / body / semantic similarity, server-side using the account default
 * threshold). Rendered in the expandable viewport on the Types page.
 */
export function TypeBlockList({ type }: { type: BlockType }) {
  const [q, setQ] = useState("");
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const rows = await api.get<Block[]>(
      `/blocks/of-type/${type.id}?q=${encodeURIComponent(q)}`,
    );
    setBlocks(rows);
  }, [type.id, q]);

  useEffect(() => {
    setLoading(true);
    const t = setTimeout(() => void load().finally(() => setLoading(false)), 250);
    return () => clearTimeout(t);
  }, [load]);

  const onDeleted = (id: string) => setBlocks((b) => b.filter((x) => x.id !== id));
  // Archived or deleted anywhere else — drop it here too, at once.
  useBlockDeleted(onDeleted);
  const { toolbar, renderList } = useBlockView(blocks, [type], { scope: `type-${type.id}` });

  return (
    <div className="type-blocklist">
      <input
        className="type-search"
        placeholder="Search title, body, or meaning…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {loading ? (
        <div className="hint">Loading…</div>
      ) : blocks.length === 0 ? (
        <div className="hint">No blocks of this type{q ? " match" : ""}.</div>
      ) : (
        <>
          {toolbar}
          {renderList((b, compact) => (
            <BlockCard
              block={b}
              type={type}
              onConflict={() => void load()}
              onDeleted={onDeleted}
              compact={compact}
            />
          ))}
        </>
      )}
    </div>
  );
}
