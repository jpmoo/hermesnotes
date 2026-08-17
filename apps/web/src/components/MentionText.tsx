import { CirclePlus, Hash } from "lucide-react";
import { useState } from "react";
import { BlockIcon, CollectionIcon } from "../lib/icons.tsx";
import { PlaceholderMenu } from "./PlaceholderMenu.tsx";
import { flattenMentions } from "../lib/display.ts";
import { parseMentions, useMentionTarget } from "../lib/mention-resolve.tsx";
import { usePanels } from "../lib/right-panel.tsx";

/**
 * The words a mention stands for, resolved but rendered as plain text.
 *
 * A block's title can itself name another block, and it's stored the way titles
 * are — `|<id>`. Read straight out, a chip for that block showed the raw id in
 * the middle of its own label: the reference was resolved, and then the thing it
 * resolved to had a reference in it that nobody looked at.
 *
 * No chip, no icon, no link: this is text inside something else's chip, and it
 * resolves one level only — a title that names a block that names a block reads
 * as far as the first one and stops, rather than fetching its way down a chain.
 */
function ResolvedWords({ href, label }: { href: string; label: string }) {
  const isTag = href.startsWith("tag:");
  const personName = href.startsWith("person:") ? href.slice(7) : "";
  const staticId = href.startsWith("block:") ? href.slice(6) : "";
  const target = useMentionTarget(staticId, personName, isTag, Boolean(label));
  const words = label || target.fetchedLabel || (target.dead ? "missing" : "…");
  return <>{isTag ? words.replace(/^#/, "") : words.replace(/^@/, "")}</>;
}

/** A label with any mentions of its own resolved to the words they stand for. */
function ResolvedLabel({ text }: { text: string }) {
  const parts = parseMentions(text);
  if (parts.every((p) => p.kind === "text")) return <>{text}</>;
  return (
    <>
      {parts.map((p, i) =>
        p.kind === "text" ? (
          <span key={i}>{p.text}</span>
        ) : (
          <ResolvedWords key={i} href={p.href} label={p.label} />
        ),
      )}
    </>
  );
}

/**
 * One mention, outside the editor: same chip, but nothing to keep in sync.
 * Exported because the assistant's replies carry the same references — a title
 * it reports back is the stored title, mentions and all.
 */
export function MentionChip({ href, label }: { href: string; label: string }) {
  const isTag = href.startsWith("tag:");
  // A placeholder names something that doesn't exist yet. Clicking it asks
  // what it should become; until then it resolves to nothing.
  const placeholder = href.startsWith("new:") ? decodeURIComponent(href.slice(4)) : "";
  // Read as a name, not as it had to be typed — the trigger can't take a space,
  // so an underscore is where the space went. The href keeps the written form,
  // which is what the notes carrying this placeholder say and what creating it
  // has to match on.
  const placeholderName = placeholder.replace(/_/g, " ");
  // Words that keep coming back, marked rather than linked.
  const forwarded = href.startsWith("fwd:");
  const [askAt, setAskAt] = useState<{ x: number; y: number } | null>(null);
  const personName = href.startsWith("person:") ? href.slice(7) : "";
  const staticId = href.startsWith("block:") ? href.slice(6) : "";
  const target = useMentionTarget(staticId, personName, isTag, Boolean(label));
  const { selectOrOpen } = usePanels();

  // The person glyph already says it's a person, so the "@" is just noise in a
  // title that's read rather than edited.
  const raw = label || target.fetchedLabel || (target.dead ? "missing" : "…");
  const text = placeholderName || (isTag ? raw.replace(/^#/, "") : raw.replace(/^@/, ""));
  return (
    <>
    <span
      className={`mention-chip mention-inline${isTag ? " tag" : ""}${forwarded ? " forwarded" : ""}${
        placeholder ? " placeholder" : ""
      }${target.dead && !placeholder ? " dead" : ""}${
        target.archived && !target.dead ? " archived" : ""
      }`}
      // The chip sits inside cards that are themselves clickable, so a click here
      // must not also select the card behind it.
      onClick={(e) => {
        e.stopPropagation();
        if (forwarded) return;
        if (placeholder) {
          setAskAt({ x: e.clientX, y: e.clientY });
          return;
        }
        if (isTag || target.dead || !target.id) return;
        selectOrOpen(target.id, { collection: target.collection });
      }}
      onPointerDown={(e) => e.stopPropagation()}
      // The tooltip is one plain string, so a nested reference is flattened
      // rather than resolved — `|…` says "and something else" without pretending
      // to name it.
      title={
        target.dead
          ? `${flattenMentions(label) || "reference"} — no longer exists`
          : target.archived
            ? `${flattenMentions(text)} — archived`
            : flattenMentions(text)
      }
    >
      {forwarded ? null : placeholder ? (
        <CirclePlus size={13} />
      ) : isTag ? (
        <Hash size={13} />
      ) : target.collection ? (
        <CollectionIcon
          document={target.collectionMeta?.document}
          matrix={target.collectionMeta?.matrix}
          table={target.collectionMeta?.table}
          canvas={target.collectionMeta?.canvas}
          calendar={target.collectionMeta?.calendar}
          rollup={target.collectionMeta?.rollup}
          smart={target.collectionMeta?.smart}
          size={13}
        />
      ) : (
        <BlockIcon iconKey={target.icon?.key} color={target.icon?.color} size={13} />
      )}
      <span>
        <ResolvedLabel text={text} />
      </span>
    </span>
    {askAt && (
      <PlaceholderMenu
        label={placeholder}
        at={askAt}
        onClose={() => setAskAt(null)}
        onCreated={() => setAskAt(null)}
      />
    )}
    </>
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
          <MentionChip key={i} href={p.href} label={p.label} />
        ),
      )}
    </>
  );
}
