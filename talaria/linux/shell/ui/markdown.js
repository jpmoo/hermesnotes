/*
 * Just enough Markdown, ported from `MarkdownText` in `app/Sources/Theme.swift`.
 *
 * The same block kinds the Mac recognizes — heading, bullet, numbered, fenced
 * code, paragraph — because what is being rendered is the same model's output,
 * and the two clients should not disagree about what it said.
 *
 * No library. This is a page served over a Unix socket with no network of its
 * own, and pulling a parser off a CDN to bold some words would be the only
 * outbound request the whole application makes.
 *
 * **Escaped first, marked up second, and that order is the whole safety story.**
 * The text is a language model's output, which is to say text from outside. It
 * is escaped into inert HTML before a single tag is introduced, so anything
 * arriving that looks like markup is shown as the characters it is rather than
 * run as the markup it imitates.
 */

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

/**
 * Inline markup, applied to already-escaped text.
 *
 * Code spans are lifted out first and put back last, so backticked text is
 * never itself interpreted — "`**not bold**`" is what somebody meant when they
 * typed it, and is exactly the case a single-pass replace gets wrong.
 *
 * The placeholder is a NUL-delimited index rather than anything printable. An
 * earlier attempt parked the index between spaces, which happily matched any
 * number in the reply that had spaces around it and swapped a year for a code
 * span.
 */
function inline(escaped) {
  const spans = [];
  let s = escaped.replace(/`([^`]+)`/g, (_, code) => {
    spans.push(code);
    return "\u0000" + (spans.length - 1) + "\u0000";
  });

  // Links before emphasis: a URL may contain underscores, and reading those as
  // italics turns a working link into a broken one with an <em> in the middle.
  // Only http(s) — a `javascript:` href is the one thing markdown could
  // otherwise smuggle past the escaping above.
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, text, href) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`,
  );

  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>");

  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${spans[Number(i)]}</code>`);
}

/** Markdown to a DocumentFragment — never a string of HTML handed to innerHTML. */
export function render(text) {
  const out = document.createDocumentFragment();
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");

  let fence = null;
  let list = null; // the <ul>/<ol> being filled, so consecutive items group

  const closeList = () => { list = null; };
  const intoList = (tag) => {
    if (!list || list.tagName.toLowerCase() !== tag) {
      list = document.createElement(tag);
      out.appendChild(list);
    }
    return list;
  };
  const block = (tag, markup) => {
    const node = document.createElement(tag);
    node.innerHTML = inline(escape(markup));
    out.appendChild(node);
  };
  const fenced = (body) => {
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    // textContent, not innerHTML: a fenced block is the one place the content
    // is guaranteed to be shown rather than interpreted.
    code.textContent = body;
    pre.appendChild(code);
    out.appendChild(pre);
  };

  for (const raw of lines) {
    const t = raw.trim();

    if (t.startsWith("```")) {
      if (fence !== null) { fenced(fence.join("\n")); fence = null; } else { fence = []; }
      closeList();
      continue;
    }
    if (fence !== null) { fence.push(raw); continue; }

    // A blank line ends a list and is otherwise skipped, which is what the Mac
    // does — spacing comes from the layout rather than from empty paragraphs.
    if (!t) { closeList(); continue; }

    let m;
    if ((m = /^(#{1,6})\s*(.*)$/.exec(t))) {
      closeList();
      block(m[1].length <= 1 ? "h2" : "h3", m[2]);
    } else if (/^[-*]\s+/.test(t)) {
      const li = document.createElement("li");
      li.innerHTML = inline(escape(t.replace(/^[-*]\s+/, "")));
      intoList("ul").appendChild(li);
    } else if ((m = /^(\d+)\.\s*(.*)$/.exec(t))) {
      const li = document.createElement("li");
      li.innerHTML = inline(escape(m[2]));
      intoList("ol").appendChild(li);
    } else if (/^>\s?/.test(t)) {
      closeList();
      block("blockquote", t.replace(/^>\s?/, ""));
    } else {
      closeList();
      block("p", t);
    }
  }

  // An unclosed fence still has content worth showing: dropping it would lose
  // the tail of a reply that was cut off mid-block.
  if (fence !== null && fence.length) fenced(fence.join("\n"));

  return out;
}
