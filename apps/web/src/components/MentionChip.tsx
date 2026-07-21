import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { Hash } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Block, type BlockType } from "../api.ts";
import { BlockIcon } from "../lib/icons.tsx";
import { usePanels } from "../lib/right-panel.tsx";

// Small module caches so repeated chips don't refetch.
let typesPromise: Promise<BlockType[]> | null = null;
const blockCache = new Map<string, Promise<Block | null>>();

const getTypes = () => (typesPromise ??= api.get<BlockType[]>("/block-types").catch(() => []));
const getBlock = (id: string) =>
  blockCache.get(id) ??
  blockCache.set(id, api.get<Block>(`/blocks/${id}`).catch(() => null)).get(id)!;

interface Icon {
  key?: string | null;
  color?: string | null;
}

/** Renders a mention as an icon-prefixed, clickable chip inside the editor. */
export function MentionChip({ node }: NodeViewProps) {
  const href = String(node.attrs.href ?? "");
  const label = String(node.attrs.label ?? "");
  const isTag = href.startsWith("tag:");
  const id = href.startsWith("block:") ? href.slice(6) : "";
  const [icon, setIcon] = useState<Icon | null>(null);
  const [collection, setCollection] = useState(false);
  const { pushBlock } = usePanels();
  const nav = useNavigate();

  useEffect(() => {
    if (isTag || !id) return;
    let alive = true;
    void (async () => {
      const b = await getBlock(id);
      if (!alive || !b) return;
      if (b.collectionKind) {
        setCollection(true);
        setIcon({ key: "folder" });
        return;
      }
      const types = await getTypes();
      const t = types.find((x) => x.id === b.blockTypeId);
      if (alive) setIcon({ key: t?.isText ? "type" : t?.iconKey, color: t?.iconColor });
    })();
    return () => {
      alive = false;
    };
  }, [id, isTag]);

  const onClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isTag || !id) return;
    if (collection) nav(`/collections/${id}`);
    else pushBlock(id);
  };

  return (
    <NodeViewWrapper
      as="span"
      className={`mention-chip${isTag ? " tag" : ""}`}
      contentEditable={false}
      onClick={onClick}
      title={label}
    >
      {isTag ? <Hash size={13} /> : <BlockIcon iconKey={icon?.key} color={icon?.color} size={13} />}
      <span>{isTag ? label.replace(/^#/, "") : label}</span>
    </NodeViewWrapper>
  );
}
