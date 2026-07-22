import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { Hash } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type Block, type BlockType } from "../api.ts";
import { BlockIcon, CollectionIcon } from "../lib/icons.tsx";
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
  const [collectionMeta, setCollectionMeta] = useState<{ document: boolean; matrix: boolean; smart: boolean }>();
  const { openBlock } = usePanels();

  useEffect(() => {
    if (isTag || !id) return;
    let alive = true;
    void (async () => {
      const b = await getBlock(id);
      if (!alive || !b) return;
      if (b.collectionKind) {
        setCollection(true);
        setCollectionMeta({
          document: b.collectionKind === "document",
          matrix: b.collectionKind === "matrix",
          smart: (b.properties as Record<string, unknown>)?.membership_mode === "smart",
        });
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

  // Navigate on MOUSEDOWN, not click: the plain mousedown would move the
  // editor selection into this line, and the active-line extension then swaps
  // the paragraph to raw source — destroying the chip before its click event
  // can ever fire. preventDefault keeps the selection (and the chip) intact.
  const onActivate = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isTag || !id) return;
    openBlock(id, { collection });
  };
  const swallow = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <NodeViewWrapper
      as="span"
      className={`mention-chip${isTag ? " tag" : ""}`}
      contentEditable={false}
      onMouseDown={onActivate}
      onClick={swallow}
      title={label}
    >
      {isTag ? (
        <Hash size={13} />
      ) : collection ? (
        <CollectionIcon document={collectionMeta?.document} matrix={collectionMeta?.matrix} smart={collectionMeta?.smart} size={13} />
      ) : (
        <BlockIcon iconKey={icon?.key} color={icon?.color} size={13} />
      )}
      <span>{isTag ? label.replace(/^#/, "") : label}</span>
    </NodeViewWrapper>
  );
}
