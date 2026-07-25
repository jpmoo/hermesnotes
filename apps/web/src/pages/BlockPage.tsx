import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, type Block, type BlockType } from "../api.ts";
import { BlockCard } from "../components/BlockCard.tsx";
import { usePanels } from "../lib/right-panel.tsx";
import { useSetRouteBanner } from "../lib/route-banner.tsx";

/** Full-page view of a single block. */
export function BlockPage() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const [block, setBlock] = useState<Block | null>(null);
  const [types, setTypes] = useState<BlockType[]>([]);
  const [loading, setLoading] = useState(true);
  const [gone, setGone] = useState(false);
  const { selectBlock, selectedBlockId } = usePanels();

  const load = useCallback(
    () =>
      Promise.all([api.get<Block>(`/blocks/${id}`), api.get<BlockType[]>("/block-types")])
        .then(([b, ts]) => {
          setBlock(b);
          setTypes(ts);
        })
        .catch(() => setGone(true))
        .finally(() => setLoading(false)),
    [id],
  );

  useEffect(() => {
    setLoading(true);
    setGone(false);
    void load();
  }, [load]);

  // Viewing a block full-page logs it as the current note (e.g. direct links).
  const selRef = useRef(selectedBlockId);
  selRef.current = selectedBlockId;
  useEffect(() => {
    if (id && selRef.current !== id) selectBlock(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useSetRouteBanner(block ? (block.properties as Record<string, unknown>).banner : null);

  if (loading) return <div className="hint">Loading…</div>;
  if (gone || !block) return <div className="hint">Block not found.</div>;

  const type = types.find((t) => t.id === block.blockTypeId);
  return (
    <BlockCard block={block} type={type} onConflict={() => void load()} onDeleted={() => nav(-1)} />
  );
}
