/**
 * Single-line display + relative-date helpers shared by server and client.
 * (The web app re-implements the HTML-rendering variants in its own lib because
 * it imports @hermes/shared type-only; these plain-string helpers are safe to
 * share and are used by the server for search/reference labels and queries.)
 */

/** Strip leading markdown block markers (#, >, -, 1.) from a single line. */
function stripLineMarkers(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s+/, "")
    .replace(/^[-*+]\s+(\[[ xX]?\]\s+)?/, "")
    .replace(/^\d+\.\s+/, "");
}

/**
 * First sentence of a blob of text — the first non-empty line, cut at the first
 * sentence terminator (. ! ?) if there is one, markdown markers stripped.
 */
export function firstSentence(text: string): string {
  const line =
    (text ?? "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const stripped = stripLineMarkers(line);
  const m = stripped.match(/^(.*?[.!?])(\s|$)/);
  return (m?.[1] ?? stripped).trim();
}

/**
 * The single-line label for a block (doc: lists, search results, references):
 * the `title` property if present, else the first sentence of the `description`
 * property, else the first sentence of the block's text `content` (a text
 * note's body is its description, labelled "Body").
 */
export function oneLineLabel(
  properties: Record<string, unknown> | null | undefined,
  content?: string | null,
): string {
  const title = properties?.title;
  if (typeof title === "string" && title.trim()) return title.trim();
  const desc = properties?.description;
  const source =
    typeof desc === "string" && desc.trim() ? desc : typeof content === "string" ? content : "";
  return firstSentence(source);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Resolve a relative date token used in smart-collection queries. Supports:
 *   today           -> YYYY-MM-DD (server local date)
 *   today+N / today-N -> that many days offset
 *   now             -> YYYY-MM-DDTHH:mm
 * Anything else (an ISO date/datetime, a plain value) is returned unchanged, so
 * literal values pass straight through.
 */
/**
 * "Now" as a Date whose server-local Y/M/D/H:M mirror the user's wall clock in
 * their configured IANA timezone (null/undefined = server local), so a caller
 * reading its Y/M/D fields gets the user's calendar day — not the server's,
 * which can already be on the next date in the evening (the box runs UTC).
 */
export function userLocalNow(tz: string | null | undefined, base: Date = new Date()): Date {
  if (!tz) return base;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(base);
    const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    return new Date(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second"));
  } catch {
    return base;
  }
}

export function resolveDateToken(value: string, now: Date): string {
  const s = (value ?? "").trim().toLowerCase();
  const today = s.match(/^today\s*([+-]\s*\d+)?$/);
  if (today) {
    const off = today[1] ? parseInt(today[1].replace(/\s+/g, ""), 10) : 0;
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + off);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  if (s === "now") {
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}T${pad2(
      now.getHours(),
    )}:${pad2(now.getMinutes())}`;
  }
  return value;
}
