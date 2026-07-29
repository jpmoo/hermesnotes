import type { ReactNode } from "react";

/** Decode the common HTML entities that show up in feed descriptions. */
function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  };
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (full, code: string) => {
    if (code[0] === "#") {
      const n = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : full;
    }
    return named[code.toLowerCase()] ?? full;
  });
}

/**
 * Render a calendar feed's description as safe React nodes: flatten any HTML to
 * text (preserving anchor targets and line breaks) and linkify bare URLs. Feed
 * content is untrusted, so nothing is injected as raw HTML.
 */
export function renderFeedText(raw: string): ReactNode[] {
  let text = raw
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, (_full, href: string, label: string) => {
      const l = label.replace(/<[^>]+>/g, "").trim();
      return l && l !== href ? `${l} (${href})` : href;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "• ")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  text = decodeEntities(text).replace(/\n{3,}/g, "\n\n").trim();

  const parts: ReactNode[] = [];
  const re = /(https?:\/\/[^\s<]+[^\s<.,)!?])|(www\.[^\s<]+[^\s<.,)!?])/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const url = m[0];
    const href = url.startsWith("http") ? url : `https://${url}`;
    parts.push(
      <a key={i++} href={href} target="_blank" rel="noreferrer noopener">
        {url}
      </a>,
    );
    last = m.index + url.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
