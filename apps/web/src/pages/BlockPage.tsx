import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, type Block, type BlockType } from "../api.ts";
import { BlockCard } from "../components/BlockCard.tsx";

/** Full-page view of a single block (the info pane's "expand" target). */
export function BlockPage() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const [block, setBlock] = useState<Block | null>(null);
  const [types, setTypes] = useState<BlockType[]>([]);
  const [loading, setLoading] = useState(true);
  const [gone, setGone] = useState(false);

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

  if (loading) return <div className="hint">Loading…</div>;
  if (gone || !block) return <div className="hint">Block not found.</div>;

  const type = types.find((t) => t.id === block.blockTypeId);
  return (
    <>
      <button className="ghost back-link" onClick={() => nav(-1)}>
        <ArrowLeft size={16} />
        Back
      </button>
      <BlockCard block={block} type={type} onConflict={() => void load()} onDeleted={() => nav(-1)} />
    </>
  );
}
