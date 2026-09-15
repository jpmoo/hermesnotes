import type { Node as PMNode } from "@tiptap/pm/model";
import { Selection } from "@tiptap/pm/state";

/**
 * The line of a selection that names what it becomes, and where its body starts.
 *
 * The first line with words in it is the title, and everything after that line
 * is the body — the same split Talaria's New Block makes of a selection.
 *
 * **A line, not a paragraph.** One Enter in a Hermes note is one newline *inside*
 * the paragraph (see `ActiveLineSource`), so three lines typed one under another
 * are a single paragraph broken twice. A title that ran to the end of the
 * paragraph made all three lines the title and left the body empty. So a line
 * ends at whichever comes first: a line break, a newline in a line still showing
 * its markdown, or the end of the block.
 *
 * `words` reads a range as text, so a line holding only a mention chip still
 * counts as having words in it.
 *
 * `start`/`end` bound the title; `next` is where the body begins — just past the
 * title's break, since the break belongs to the title's line.
 */
export function titleLine(
  doc: PMNode,
  from: number,
  to: number,
  words: (start: number, end: number) => string,
): { start: number; end: number; next: number } {
  const lineFrom = (start: number): { end: number; next: number } => {
    const $start = doc.resolve(start);
    const blockEnd = Math.min(to, $start.end($start.depth));
    const hits: { end: number; next: number }[] = [];
    doc.nodesBetween(start, blockEnd, (node, pos) => {
      if (hits.length) return false;
      if (node.type.name === "hardBreak" && pos >= start) {
        hits.push({ end: pos, next: pos + node.nodeSize });
        return false;
      }
      if (node.isText && node.text) {
        const i = node.text.indexOf("\n", Math.max(0, start - pos));
        if (i >= 0 && pos + i < blockEnd) hits.push({ end: pos + i, next: pos + i + 1 });
      }
      return true;
    });
    return hits[0] ?? { end: blockEnd, next: blockEnd };
  };

  let start = from;
  let line = lineFrom(start);
  // Blank lines at the top name nothing: move on to the first line with words.
  for (let guard = 0; guard < 50; guard++) {
    if (words(start, line.end).trim()) break;
    // Past the break, or out of this block into the next one with text in it.
    const onward = Selection.findFrom(doc.resolve(Math.min(to, Math.max(line.next, line.end + 1))), 1, true);
    if (!onward || onward.from >= to || onward.from <= start) break;
    start = onward.from;
    line = lineFrom(start);
  }
  return { start, end: line.end, next: line.next };
}
