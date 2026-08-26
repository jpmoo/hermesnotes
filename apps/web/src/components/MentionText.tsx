import { CirclePlus, Hash } from "lucide-react";
import { useState } from "react";
import { BlockIcon, CollectionIcon } from "../lib/icons.tsx";
import { PlaceholderMenu } from "./PlaceholderMenu.tsx";
import { flattenMentions } from "../lib/display.ts";
import { parseMentions, ResolvedLabel, forgetPerson, useMentionTarget } from "../lib/mention-resolve.tsx";
import { usePanels } from "../lib/right-panel.tsx";

/**
 * One mention, outside the editor: same chip, but nothing to keep in sync.
 * Exported because the assistant's replies carry the same references — a title
 * it reports back is the stored title, mentions and all.
 */
export function MentionChip({ href, label }: { href: string; label: string }) {
  const isTag = href.startsWith("tag:");
  // Words that keep coming back, marked rather than linked.
  const forwarded = href.startsWith("fwd:");
  const [askAt, setAskAt] = useState<{ x: number; y: number } | null>(null);
  const personName = href.startsWith("person:") ? href.slice(7) : "";
  const staticId = href.startsWith("block:") ? href.slice(6) : "";
  const target = useMentionTarget(staticId, personName, isTag, Boolean(label));
  // A name that resolves to nothing is not a dead link.
  //
  // `block:<id>` failing to resolve means something was deleted — that is dead,
  // and there is nothing to be done about it. A bare `@Name` failing to resolve
  // means the opposite: nobody has created that person yet. Nothing was lost;
  // the name was written before the thing existed, which is exactly what a
  // placeholder is.
  //
  // Both arrived here as `dead`, so `@Cesar_Morales` rendered as a corpse,
  // reported "no longer exists" for somebody who never existed, and returned
  // early from every click. The name is right there and creating from it is one
  // menu — so a name with no thing behind it opens that menu, as `new:` does.
  const unresolvedName = Boolean(personName) && target.dead;
  const placeholder = href.startsWith("new:")
    ? decodeURIComponent(href.slice(4))
    : unresolvedName
      ? personName
      : "";
  // Read as a name, not as it had to be typed — the trigger can't take a space,
  // so an underscore is where the space went. The href keeps the written form,
  // which is what the notes carrying this placeholder say and what creating it
  // has to match on.
  const placeholderName = placeholder.replace(/_/g, " ");
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
        placeholder
          ? `${placeholderName} — not created yet. Click to make one.`
          : target.dead
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
        onCreated={() => {
          // A bare `@Name` has no href to rewrite — it resolves by name, so it
          // fixes itself the moment the name resolves. What has to go is the
          // cached "nobody is called that", or the person exists and the chip
          // keeps saying otherwise until a reload.
          if (unresolvedName) forgetPerson(personName);
          setAskAt(null);
        }}
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
