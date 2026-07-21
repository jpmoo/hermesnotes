function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Render the first non-empty line of markdown to safe inline HTML for a one-line
 * list excerpt: strips block markers (#, >, -, 1.), keeps bold/italic/code, and
 * flattens links to their text. HTML is escaped first, so no user markup passes.
 */
export function firstLineHtml(md: string): string {
  const raw =
    (md ?? "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";

  const stripped = raw
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s+/, "")
    .replace(/^[-*+]\s+(\[[ xX]?\]\s+)?/, "")
    .replace(/^\d+\.\s+/, "");

  let html = escapeHtml(stripped);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  return html;
}
