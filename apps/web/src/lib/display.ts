import { inlineMarkdown } from "./markdown-excerpt.ts";

/**
 * Single-line block display (lists, cards, results). Mirrors the server's
 * @hermes/shared display helpers, re-implemented here because the web app
 * imports @hermes/shared type-only.
 *
 * Rule: use the `title` property if present; otherwise the first sentence of the
 * `description` property; for text notes (no properties) the body `content` is
 * the description ("Body").
 */

/** First non-empty line, cut at the first sentence terminator, markers stripped. */
export function firstSentence(text: string): string {
  const line =
    (text ?? "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const stripped = line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s+/, "")
    .replace(/^[-*+]\s+(\[[ xX]?\]\s+)?/, "")
    .replace(/^\d+\.\s+/, "");
  const m = stripped.match(/^(.*?[.!?])(\s|$)/);
  return (m?.[1] ?? stripped).trim();
}

/** The raw one-line source string (title, else first sentence of description/body). */
export function oneLineText(
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

/** The one-line label rendered to safe inline HTML (bold/italic/code kept). */
export function oneLineHtml(
  properties: Record<string, unknown> | null | undefined,
  content?: string | null,
): string {
  return inlineMarkdown(oneLineText(properties, content));
}

/** True when a stored date/datetime string is in the past (date-only values
 * only become overdue after their day ends). */
export function isOverdue(v: string | null | undefined): boolean {
  if (!v) return false;
  const now = new Date();
  if (v.includes("T")) {
    const d = new Date(v);
    return !Number.isNaN(d.getTime()) && d.getTime() < now.getTime();
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return v < today;
}
