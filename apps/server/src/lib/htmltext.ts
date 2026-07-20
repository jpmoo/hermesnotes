/**
 * Reduce text-block HTML (from TipTap) to plain text for the embedding pipeline.
 * We embed meaning, not markup — block-level tags become newlines, inline tags
 * drop out, entities are decoded. Deliberately small; not a general HTML parser.
 */
const BLOCK_TAGS = /<\/(p|div|h[1-6]|li|blockquote|pre|br)>|<br\s*\/?>/gi;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

export function htmlToText(html: string): string {
  return html
    .replace(BLOCK_TAGS, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m] ?? m)
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}
