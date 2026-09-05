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

  /*
   * A mention, as Hermes writes one.
   *
   * `@`, `#` and `|` in an editor insert an ordinary markdown link whose href
   * is `block:<id>` or `tag:<name>` — `apps/web/src/lib/mentions.ts` says why in
   * one line: "inserted as a markdown link so it round-trips". Nothing about
   * the file format knows what a chip is, which is what makes a note written
   * here readable by anything that reads markdown.
   *
   * Rendered as a chip rather than a link because it is not somewhere to go so
   * much as something named — and the id is not worth showing anybody. The
   * href is kept verbatim for whoever handles the click; the schemes are
   * matched exactly, so this is not a door for `javascript:`.
   */
  s = s.replace(
    /\[([^\]]+)\]\((block:[0-9a-fA-F-]+|tag:[^\s)]+)\)/g,
    (_, text, href) => {
      const kind = href.startsWith("tag:") ? "tag" : "block";
      return `<a class="chip-link ${kind}" href="${href}">${text}</a>`;
    },
  );

  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>");

  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${spans[Number(i)]}</code>`);
}

/**
 * A pipe table.
 *
 * `rows[1]` is the separator and is read for alignment rather than shown. Cells
 * carry inline markup, because the assistant bolds things inside them and a
 * table of literal asterisks is worse than no table.
 */
function table(rows) {
  const el = (t) => document.createElement(t);
  const cells = (line) =>
    line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());

  const align = (rows[1] || "").split("|").map((c) => {
    const t = c.trim();
    if (t.startsWith(":") && t.endsWith(":")) return "center";
    if (t.endsWith(":")) return "right";
    return "";
  }).filter((_, i, a) => a.length);

  const node = el("table");
  const head = el("tr");
  for (const [i, c] of cells(rows[0]).entries()) {
    const th = el("th");
    th.innerHTML = inline(escape(c));
    if (align[i]) th.style.textAlign = align[i];
    head.appendChild(th);
  }
  node.appendChild(head);

  for (const line of rows.slice(2)) {
    const tr = el("tr");
    for (const [i, c] of cells(line).entries()) {
      const td = el("td");
      td.innerHTML = inline(escape(c));
      if (align[i]) td.style.textAlign = align[i];
      tr.appendChild(td);
    }
    node.appendChild(tr);
  }

  // Tables are the one thing here that legitimately exceeds the panel's width,
  // and a panel that scrolls sideways as a whole is a broken panel.
  const scroller = el("div");
  scroller.className = "table-scroll";
  scroller.appendChild(node);
  return scroller;
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

  for (let at = 0; at < lines.length; at++) {
    const raw = lines[at];
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
    // A table, which the assistant reaches for constantly — every "what is due
    // this week" comes back as one — and which was rendering as a wall of
    // pipes. Recognized by its separator row rather than by the first row
    // alone: a single line with pipes in it is a sentence with pipes in it, and
    // only the `|---|---|` beneath makes it a table.
    // Found by position rather than by `indexOf` — a document with the same
    // line twice in it (a daily note has many) matched the first one and
    // consumed rows from the wrong place.
    if (t.includes("|") && /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(lines[at + 1] || "")) {
      closeList();
      const rows = [];
      let i = at;
      while (i < lines.length && lines[i].trim().includes("|")) rows.push(lines[i++].trim());
      // Consumed here, so the loop does not meet them again as paragraphs.
      lines.splice(at, rows.length, ...new Array(rows.length).fill(""));
      out.appendChild(table(rows));
      continue;
    }
    if ((m = /^(#{1,6})\s*(.*)$/.exec(t))) {
      closeList();
      block(m[1].length <= 1 ? "h2" : "h3", m[2]);
    } else if ((m = /^[-*]\s+\[([ xX])\]\s*(.*)$/.exec(t))) {
      /*
       * A task line, which is most of what a daily note is.
       *
       * The box is a real checkbox and it carries the line it came from, so
       * whoever is holding the source can toggle exactly that line without
       * re-parsing the document or guessing between two identical tasks. A
       * reader that only displays markdown leaves it disabled; the field in
       * `notefield.js` enables it.
       */
      const li = document.createElement("li");
      li.className = "task";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = m[1] !== " ";
      box.disabled = true;
      box.dataset.line = String(at);
      const said = document.createElement("span");
      said.innerHTML = inline(escape(m[2]));
      li.append(box, said);
      if (box.checked) li.classList.add("is-done");
      intoList("ul").appendChild(li);
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
