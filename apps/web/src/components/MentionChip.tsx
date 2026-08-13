import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { Hash } from "lucide-react";
import { BlockIcon, CollectionIcon } from "../lib/icons.tsx";
import { useMentionTarget } from "../lib/mention-resolve.tsx";
import { usePanels } from "../lib/right-panel.tsx";

/** Renders a mention as an icon-prefixed, clickable chip inside the editor. */
export function MentionChip({ node }: NodeViewProps) {
  const href = String(node.attrs.href ?? "");
  const label = String(node.attrs.label ?? "");
  const isTag = href.startsWith("tag:");
  const personName = href.startsWith("person:") ? href.slice(7) : "";
  const staticId = href.startsWith("block:") ? href.slice(6) : "";
  const { id, fetchedLabel, icon, collection, collectionMeta, dead, archived } = useMentionTarget(
    staticId,
    personName,
    isTag,
    Boolean(label),
  );
  const { openBlock } = usePanels();

  // Navigate on MOUSEDOWN, not click: the plain mousedown would move the
  // editor selection into this line, and the active-line extension then swaps
  // the paragraph to raw source — destroying the chip before its click event
  // can ever fire. preventDefault keeps the selection (and the chip) intact.
  const onActivate = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isTag || dead || !id) return;
    openBlock(id, { collection });
  };
  const swallow = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <NodeViewWrapper
      as="span"
      className={`mention-chip${isTag ? " tag" : ""}${dead ? " dead" : ""}${archived && !dead ? " archived" : ""}`}
      contentEditable={false}
      onMouseDown={onActivate}
      onClick={swallow}
      title={
        dead
          ? `${label || "reference"} — no longer exists`
          : archived
            ? `${label || fetchedLabel || "reference"} — archived`
            : label || fetchedLabel
      }
    >
      {isTag ? (
        <Hash size={13} />
      ) : collection ? (
        <CollectionIcon document={collectionMeta?.document} matrix={collectionMeta?.matrix} table={collectionMeta?.table} canvas={collectionMeta?.canvas} calendar={collectionMeta?.calendar} rollup={collectionMeta?.rollup} smart={collectionMeta?.smart} size={13} />
      ) : (
        <BlockIcon iconKey={icon?.key} color={icon?.color} size={13} />
      )}
      <span>{isTag ? label.replace(/^#/, "") : label || fetchedLabel || (dead ? "missing" : "…")}</span>
    </NodeViewWrapper>
  );
}
