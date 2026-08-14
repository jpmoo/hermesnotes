/**
 * Text sent forward from one periodic note to the next.
 *
 * Something written on a Tuesday that needs to keep being in front of you —
 * a question you're sitting with, a thing you keep meaning to do — is marked
 * and then travels: when the next daily note is made, it's copied in at the
 * top. Copied, not projected. Each day's note keeps its own words, so stopping
 * it tomorrow doesn't rewrite what you wrote yesterday.
 *
 * It's stored as a markdown link with a `fwd:` scheme, carrying the moment it
 * was first sent — which is what orders several of them, oldest first, and what
 * survives the round trip through markdown that any other marker wouldn't.
 */

/**
 * `<mark data-fwd="<iso>">…</mark>`, the form marked text is stored in. The
 * inner text is kept as markdown, so mentions inside it travel as mentions.
 */
const FORWARD_RE = /<mark\s+data-fwd="([^"]*)"\s*>([\s\S]*?)<\/mark>/g;

/**
 * The first form: a mention node carrying the text as a flat label. Anything
 * marked before the change is still read, and still travels — as the words it
 * was reduced to, since that's all that was kept of it.
 */
const LEGACY_RE = /\[([^\]]*)\]\(fwd:([^)]+)\)/g;

export interface ForwardedLine {
  /** The text itself, as written. */
  text: string;
  /** When it was first sent forward — the order they appear in. */
  since: string;
}

/** Build the stored form around a piece of markdown. */
export function forwardMark(markdown: string, since: string): string {
  const inner = String(markdown ?? "")
    .replace(/\s*\n\s*/g, " ")
    .trim();
  return `<mark data-fwd="${since.replace(/"/g, "&quot;")}">${inner}</mark>`;
}

/** Every piece of text a note is sending forward, oldest first. */
export function forwardedIn(content: string | null | undefined): ForwardedLine[] {
  if (!content) return [];
  const out: ForwardedLine[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  // Both forms, so a note written before the change still carries its text.
  const found: { text: string; since: string }[] = [];
  FORWARD_RE.lastIndex = 0;
  while ((m = FORWARD_RE.exec(content)) !== null) {
    found.push({ text: (m[2] ?? "").trim(), since: m[1] ?? "" });
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
  for (const { text, since } of found) {
    if (!text) continue;
    // The same text sent forward twice is one thing; keep the older claim.
    const key = `${text}${since}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, since });
  }
  return out.sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0));
}

/**
 * What a newly created periodic note should open with, given the most recent
 * earlier one that had anything in it. Each piece on its own line at the top,
 * in the order they were first sent, with a blank line after so today's writing
 * starts on clean paper.
 */
export function carryForward(previousContent: string | null | undefined): string {
  const lines = forwardedIn(previousContent);
  if (lines.length === 0) return "";
  return `${lines.map((l) => forwardMark(l.text, l.since)).join("\n\n")}\n\n`;
}
