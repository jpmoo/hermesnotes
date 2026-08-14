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

/** Flatten stored mention syntax for display: markdown links → label,
 * `@Name_X` → "@Name X", bare `|<id>` → a placeholder. `#tag` reads fine raw. */
export function flattenMentions(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\((?:block|tag|person|new|fwd):[^)]+\)/g, "$1")
    .replace(/@([A-Za-z0-9][\w-]*)/g, (_m, n: string) => `@${n.replace(/_/g, " ")}`)
    .replace(/\|[0-9a-fA-F-]{36}/g, "|…");
}

/**
 * The stored one-line label, mentions and all — for surfaces that render them
 * (see MentionText). oneLineText flattens the same string for places that can
 * only hold plain text, where a block mention becomes "|…" for want of anywhere
 * to resolve it.
 */
export function rawOneLine(
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

/** The raw one-line source string (title, else first sentence of description/body). */
export function oneLineText(
  properties: Record<string, unknown> | null | undefined,
  content?: string | null,
): string {
  const title = properties?.title;
  if (typeof title === "string" && title.trim()) return flattenMentions(title.trim());
  const desc = properties?.description;
  const source =
    typeof desc === "string" && desc.trim() ? desc : typeof content === "string" ? content : "";
  return flattenMentions(firstSentence(source));
}

/** The one-line label rendered to safe inline HTML (bold/italic/code kept). */
export function oneLineHtml(
  properties: Record<string, unknown> | null | undefined,
  content?: string | null,
): string {
  return inlineMarkdown(oneLineText(properties, content));
}

/**
 * True when a stored date/datetime string is in the past (date-only values only
 * become overdue after their day ends).
 *
 * `today` is the day to judge against — the page's own date on a Daily, where a
 * task that was due that afternoon shouldn't be flagged as late by the fact that
 * you're reading it a week later. Defaults to the real today.
 */
export function isOverdue(v: string | null | undefined, today?: string | null): boolean {
  if (!v) return false;
  const pad = (n: number) => String(n).padStart(2, "0");
  const now = new Date();
  const day = today || `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  if (v.includes("T")) {
    // Against another day, compare by date: the hour of a day you aren't living
    // through says nothing about whether the task was late on it.
    if (today) return v.slice(0, 10) < day;
    const d = new Date(v);
    return !Number.isNaN(d.getTime()) && d.getTime() < now.getTime();
  }
  return v < day;
}

/** Perceived-luminance check: true when dark text reads well on `color`. */
export function darkTextOn(color: string): boolean {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(color);
  if (!m) return true;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h!, 16) / 255);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.55;
}
