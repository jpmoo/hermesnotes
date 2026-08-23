/**
 * References written inside prose.
 *
 * Reference fields are the links a type declares. These are the other ones: a
 * `block:` link dropped into a paragraph, a `|<id>` mention inside a title, an
 * `@Name` typed mid-sentence. In a knowledge base most of the graph lives here
 * rather than in the schema, so anything that claims to know what a block is
 * connected to has to read them.
 *
 * This module exists because two places were already doing it — the info pane
 * and the graph panel — with the same regexes copied between them, and they had
 * quietly drifted: the graph read `@Name` out of a text block's body, the info
 * pane only out of its properties, so a daily note that mentioned somebody
 * appeared connected on one surface and not the other.
 *
 * Every pattern is built fresh on each call. A module-level `/g` regex carries
 * `lastIndex` between calls, and both copies had a reset for it in one place and
 * not the other.
 */

/** `block:<uuid>` and the bare `|<uuid>` form a mention chip leaves behind. */
const blockLink = () => /block:([0-9a-fA-F-]{36})|\|([0-9a-fA-F-]{36})/g;

/** `@Some_Name` — underscores stand in for the spaces in a title. */
const atName = () => /(^|\s)@([A-Za-z0-9][\w-]*)/g;

/** Everything worth scanning: the body, plus every string-valued property. */
export function textsOf(properties: Record<string, unknown>, content: string | null): string[] {
  const out = content ? [content] : [];
  for (const v of Object.values(properties ?? {})) if (typeof v === "string" && v) out.push(v);
  return out;
}

export interface InlineMentions {
  /** Block ids named outright. */
  ids: string[];
  /** Titles named by `@`, lowercased with underscores read back as spaces. */
  names: string[];
}

/**
 * Every inline reference in a block, deduped.
 *
 * `self` drops mentions of the block itself, which a title field naming its own
 * block will otherwise produce.
 */
export function inlineMentions(
  properties: Record<string, unknown>,
  content: string | null,
  self?: string,
): InlineMentions {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const text of textsOf(properties, content)) {
    const link = blockLink();
    let m: RegExpExecArray | null;
    while ((m = link.exec(text)) !== null) {
      const target = m[1] ?? m[2];
      if (target && target !== self) ids.add(target);
    }
    const at = atName();
    while ((m = at.exec(text)) !== null) {
      if (m[2]) names.add(m[2].replace(/_/g, " ").toLowerCase());
    }
  }
  return { ids: [...ids], names: [...names] };
}

/** A title as it would be written after an `@`, for matching the other way. */
export const asAtName = (title: string) => title.trim().replace(/ /g, "_");
