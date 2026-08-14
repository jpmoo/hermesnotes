import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { CirclePlus, Hash } from "lucide-react";
import { useState } from "react";
import { PlaceholderMenu } from "./PlaceholderMenu.tsx";
import { BlockIcon, CollectionIcon } from "../lib/icons.tsx";
import { useMentionTarget } from "../lib/mention-resolve.tsx";
import { usePanels } from "../lib/right-panel.tsx";

/** Renders a mention as an icon-prefixed, clickable chip inside the editor. */
export function MentionChip({ node, updateAttributes }: NodeViewProps) {
  const href = String(node.attrs.href ?? "");
  const label = String(node.attrs.label ?? "");
  const isTag = href.startsWith("tag:");
  // Named but not yet anything: clicking asks what it should become.
  const placeholder = href.startsWith("new:") ? decodeURIComponent(href.slice(4)) : "";
  // Text that travels from one day's note to the next: not a link to
  // anywhere, just words wearing a mark that says they keep coming back.
  const forwarded = href.startsWith("fwd:");
  const [askAt, setAskAt] = useState<{ x: number; y: number } | null>(null);
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
    if (forwarded) return;
    if (placeholder) {
      setAskAt({ x: e.clientX, y: e.clientY });
      return;
    }
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
      className={`mention-chip${isTag ? " tag" : ""}${forwarded ? " forwarded" : ""}${
        placeholder ? " placeholder" : ""
      }${
        dead && !placeholder ? " dead" : ""
      }${archived && !dead ? " archived" : ""}`}
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
      {forwarded ? null : placeholder ? (
        <CirclePlus size={13} />
      ) : isTag ? (
        <Hash size={13} />
      ) : collection ? (
        <CollectionIcon document={collectionMeta?.document} matrix={collectionMeta?.matrix} table={collectionMeta?.table} canvas={collectionMeta?.canvas} calendar={collectionMeta?.calendar} rollup={collectionMeta?.rollup} smart={collectionMeta?.smart} size={13} />
      ) : (
        <BlockIcon iconKey={icon?.key} color={icon?.color} size={13} />
      )}
      <span>
        {placeholder || (isTag ? label.replace(/^#/, "") : label || fetchedLabel || (dead ? "missing" : "…"))}
      </span>
      {askAt && (
        <PlaceholderMenu
          label={placeholder}
          at={askAt}
          onClose={() => setAskAt(null)}
          // The node in hand is this editor's copy: point it at the block
          // now, or it would keep saying "new:" until the note reloaded.
          onCreated={(b) => updateAttributes({ href: `block:${b.id}`, label: placeholder })}
        />
      )}
    </NodeViewWrapper>
  );
}
