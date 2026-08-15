/**
 * Text sent forward from one periodic note to the next.
 *
 * Something written on a Tuesday that needs to keep being in front of you —
 * a question you're sitting with, a thing you keep meaning to do — is marked
 * and then travels: when the next daily note is made, it's copied in at the
 * top. Copied, not projected. Each day's note keeps its own words, so stopping
 * it tomorrow doesn't rewrite what you wrote yesterday.
 *
 * It's stored as inline HTML: `<mark data-fwd="<iso>">…</mark>`, the instant it
 * was first sent — which is what orders several of them, oldest first, and what
 * survives the round trip through markdown that any other marker wouldn't.
 *
 * A copy also carries `data-from`, the date of the note it set out from, so a
 * line you keep meeting says when you wrote it. Set once, when the text leaves
 * its first note, and passed along unchanged after that: the answer wanted is
 * where this came from, not which note handed it over most recently.
 */

/**
 * A `<mark …>…</mark>` and its attributes, read as a blob rather than in a
 * fixed order — the form gained an attribute once and may again, and a note
 * written before that still has to be readable.
 */
const MARK_RE = /<mark\s+([^>]*)>([\s\S]*?)<\/mark>/g;

/**
 * The first form: a mention node carrying the text as a flat label. Anything
 * marked before the change is still read, and still travels — as the words it
 * was reduced to, since that's all that was kept of it.
 */
const LEGACY_RE = /\[([^\]]*)\]\(fwd:([^)]+)\)/g;

/** One attribute out of a tag's attribute blob. */
function attr(blob: string, name: string): string {
  const m = new RegExp(`${name}="([^"]*)"`).exec(blob);
  return m?.[1] ? m[1].replace(/&quot;/g, '"') : "";
}

export interface ForwardedLine {
  /** The text itself, as written. */
  text: string;
  /** When it was first sent forward — the order they appear in. */
  since: string;
  /** The date (YYYY-MM-DD) of the note it set out from, once it has left it. */
  from?: string;
}

const quote = (v: string) => String(v ?? "").replace(/"/g, "&quot;");

/**
 * The opening tag on its own — for the editor, which writes the two halves
 * around content it serializes itself.
 *
 * An absent attribute is left out rather than written empty, because each one
 * means something by being there: `data-fwd` is what makes the text travel, so
 * a blank one would set text sent to a particular day walking.
 */
export function forwardOpenTag(since?: string, from?: string): string {
  return `<mark${since ? ` data-fwd="${quote(since)}"` : ""}${from ? ` data-from="${quote(from)}"` : ""}>`;
}

/** Build the stored form around a piece of markdown. */
export function forwardMark(markdown: string, since: string, from?: string): string {
  const inner = String(markdown ?? "")
    .replace(/\s*\n\s*/g, " ")
    .trim();
  return `${forwardOpenTag(since, from)}${inner}</mark>`;
}

/**
 * A piece of text set down in another day's note, saying which day it came
 * from — but not travelling on from there. Sending something to a particular
 * day is putting it there, not starting it on a journey.
 */
export function fromMark(markdown: string, from: string): string {
  const inner = String(markdown ?? "")
    .replace(/\s*\n\s*/g, " ")
    .trim();
  return `${forwardOpenTag(undefined, from)}${inner}</mark>`;
}

/** Every piece of text a note is sending forward, oldest first. */
export function forwardedIn(content: string | null | undefined): ForwardedLine[] {
  if (!content) return [];
  const out: ForwardedLine[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  // Both forms, so a note written before the change still carries its text.
  const found: ForwardedLine[] = [];
  MARK_RE.lastIndex = 0;
  while ((m = MARK_RE.exec(content)) !== null) {
    const since = attr(m[1] ?? "", "data-fwd");
    // No data-fwd means it isn't travelling — text sent to this day in
    // particular, which has arrived and stays put.
    if (!since) continue;
    const from = attr(m[1] ?? "", "data-from");
    found.push({ text: (m[2] ?? "").trim(), since, ...(from ? { from } : {}) });
  }
  LEGACY_RE.lastIndex = 0;
  while ((m = LEGACY_RE.exec(content)) !== null) {
    let since = m[2] ?? "";
    try {
      since = decodeURIComponent(since);
    } catch {
      /* hand-edited: take it as-is */
    }
    found.push({ text: (m[1] ?? "").trim(), since });
  }
  for (const line of found) {
    if (!line.text) continue;
    // The same text sent forward twice is one thing; keep the older claim.
    const key = `${line.text}${line.since}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out.sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0));
}

/**
 * What a newly created periodic note should open with, given the most recent
 * earlier one that had anything in it. Each piece on its own line at the top,
 * in the order they were first sent, with a blank line after so today's writing
 * starts on clean paper.
 *
 * `previousDate` is the day that note belongs to, stamped on anything setting
 * out for the first time. A piece already carrying an origin keeps it: it has
 * been travelling, and the day it came from is not the day it passed through.
 */
export function carryForward(
  previousContent: string | null | undefined,
  previousDate?: string | null,
): string {
  const lines = forwardedIn(previousContent);
  if (lines.length === 0) return "";
  return `${lines
    .map((l) => forwardMark(l.text, l.since, l.from || previousDate || undefined))
    .join("\n\n")}\n\n`;
}
