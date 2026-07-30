import { Hash } from "lucide-react";
import { BlockIcon, CollectionIcon } from "../lib/icons.tsx";
import { parseMentions, useMentionTarget } from "../lib/mention-resolve.tsx";
import { usePanels } from "../lib/right-panel.tsx";

/** One mention, outside the editor: same chip, but nothing to keep in sync. */
function ReadonlyChip({ href, label }: { href: string; label: string }) {
  const isTag = href.startsWith("tag:");
  const personName = href.startsWith("person:") ? href.slice(7) : "";
  const staticId = href.startsWith("block:") ? href.slice(6) : "";
  const target = useMentionTarget(staticId, personName, isTag, Boolean(label));
  const { selectOrOpen } = usePanels();

  const text = isTag ? label.replace(/^#/, "") : label || target.fetchedLabel || (target.dead ? "missing" : "…");
  return (
    <span
      className={`mention-chip${isTag ? " tag" : ""}${target.dead ? " dead" : ""}${
        target.archived && !target.dead ? " archived" : ""
      }`}
      // The chip sits inside cards that are themselves clickable, so a click here
      // must not also select the card behind it.
      onClick={(e) => {
        e.stopPropagation();
        if (isTag || target.dead || !target.id) return;
        selectOrOpen(target.id, { collection: target.collection });
      }}
      onPointerDown={(e) => e.stopPropagation()}
      title={
        target.dead
          ? `${label || "reference"} — no longer exists`
          : target.archived
            ? `${text} — archived`
            : text
      }
    >
      {isTag ? (
        <Hash size={13} />
      ) : target.collection ? (
        <CollectionIcon
          document={target.collectionMeta?.document}
          matrix={target.collectionMeta?.matrix}
          table={target.collectionMeta?.table}
          canvas={target.collectionMeta?.canvas}
          calendar={target.collectionMeta?.calendar}
          smart={target.collectionMeta?.smart}
          size={13}
        />
      ) : (
        <BlockIcon iconKey={target.icon?.key} color={target.icon?.color} size={13} />
      )}
      <span>{text}</span>
    </span>
  );
}

/**
 * A stored title rendered with its @/#/| mentions as clickable chips, for the
 * read-only surfaces — cards, chips, rows. The editor has its own version of this
 * as a node view; this one has no document to edit, so it only resolves and
 * navigates.
 */
export function MentionText({ text }: { text: string }) {
  const parts = parseMentions(text);
  // Nothing to resolve: skip the wrapper entirely so the common case (a plain
  // title) costs nothing.
  if (parts.every((p) => p.kind === "text")) return <>{text}</>;
  return (
    <>
      {parts.map((p, i) =>
        p.kind === "text" ? (
          <span key={i}>{p.text}</span>
        ) : (
          <ReadonlyChip key={i} href={p.href} label={p.label} />
        ),
      )}
    </>
  );
}
