/*
 * Markdown in, rich text out, and back again — for the writing surface.
 *
 * `markdown.js` renders a language model's reply and is deliberately one-way:
 * it takes text and produces nodes, because nothing ever asks it for the text
 * back. A writing surface needs the round trip, and needs it to be *exact* — the
 * document is somebody's own, it is saved on every pause, and a serializer that
 * loses a nested bullet loses it permanently on the next keystroke.
 *
 * So this is a second, narrower pair rather than an extension of that one. The
 * two agree on what they both handle, and this adds the things a writer types
 * and an assistant never does: checklists, nesting, strikethrough, underline,
 * and line breaks inside a paragraph.
 *
 * **Files are Markdown, not HTML.** The surface has no connection to Hermes
 * Notes and its documents live in a plain directory, so the only thing keeping
 * them useful in ten years is that they are readable by anything. HTML would
 * have made this file twenty lines long and the directory worthless.
 *
 * **Escaped first, marked up second.** The same order `markdown.js` states, for
 * the same reason: a file on disk is text from outside — it may have been
 * written by hand, or by something else — and it is turned into inert HTML
 * before a single tag is introduced.
 */

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

/**
 * Inline markup, applied to already-escaped text.
 *
 * Code spans are lifted out first and put back last, so backticked text is
 * never itself interpreted — the trap `markdown.js` documents, and the same
 * NUL-delimited placeholder, because an index parked between spaces matched
 * ordinary numbers in the prose.
 */
function inline(escaped) {
  const spans = [];
  let out = escaped.replace(/`([^`]+)`/g, (_, code) => {
    spans.push(code);
    return "\u0000" + (spans.length - 1) + "\u0000";
  });

  out = out
    // Links before emphasis, and only the schemes a document has any business
    // carrying — both rules taken from `markdown.js`, which states them: a URL
    // may contain underscores, and reading those as italics breaks the link;
    // and `javascript:` is the one thing markdown could otherwise smuggle past
    // the escaping above. Anything else stays the characters somebody typed.
    .replace(
      /\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g,
      (_, label, href) => `<a href="${href}" target="_blank" rel="noopener">${label}</a>`,
    )
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|\W)_([^_]+)_(\W|$)/g, "$1<em>$2</em>$3")
    .replace(/~~([^~]+)~~/g, "<s>$1</s>")
    // Underline has no Markdown, and a toolbar without it is not a writing
    // toolbar. Inline HTML is legal Markdown and every reader shows it, so it
    // is written literally — and read back by un-escaping this one pair and no
    // other, which keeps the "escape first" rule intact for everything else.
    .replace(/&lt;u&gt;/g, "<u>")
    .replace(/&lt;\/u&gt;/g, "</u>");

  return out.replace(/\u0000(\d+)\u0000/g, (_, at) => `<code>${spans[Number(at)]}</code>`);
}

/** `- [ ] ` and friends. Returns the marker's shape, or null for a plain line. */
function bullet(line) {
  const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
  if (!m) return null;
  const [, pad, mark, rest] = m;
  const box = /^\[([ xX])\]\s+(.*)$/.exec(rest);
  return {
    // Two spaces to a level, and anything deeper rounds down rather than
    // failing: a file edited elsewhere may well use four.
    level: Math.floor(pad.replace(/\t/g, "  ").length / 2),
    ordered: !/^[-*+]$/.test(mark),
    checked: box ? box[1] !== " " : null,
    text: box ? box[2] : rest,
  };
}

/**
 * A Markdown document, as nodes to put in a contenteditable.
 *
 * Returns a DocumentFragment. Blocks are the ones a person writing prose
 * actually reaches for; anything unrecognized is a paragraph, which is the
 * right failure — text nobody parsed is still text somebody wrote.
 */
export function fromMarkdown(source) {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const frag = document.createDocumentFragment();
  const html = (tag, markup) => {
    const node = document.createElement(tag);
    node.innerHTML = markup;
    return node;
  };

  let at = 0;
  while (at < lines.length) {
    const line = lines[at];

    if (!line.trim()) { at += 1; continue; }

    const fence = /^```(.*)$/.exec(line);
    if (fence) {
      const body = [];
      at += 1;
      while (at < lines.length && !/^```/.test(lines[at])) body.push(lines[at++]);
      at += 1;  // the closing fence, or the end of the file
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = body.join("\n");
      if (fence[1].trim()) code.dataset.language = fence[1].trim();
      pre.appendChild(code);
      frag.appendChild(pre);
      continue;
    }

    /*
     * A pipe table, which is the one block here with a shape rather than a
     * prefix: it is recognized by the *second* line, the `|---|:-:|` rule that
     * separates the heading from the body and carries the column alignment.
     * `markdown.js` renders these already; this is the same grammar, read back
     * into something editable.
     */
    if (line.includes("|") && at + 1 < lines.length && /^[\s|:-]*-[\s|:-]*$/.test(lines[at + 1])
        && lines[at + 1].includes("-")) {
      const cells = (row) => {
        const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
        // A pipe somebody meant literally is written `\|` and must not split.
        return trimmed.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
      };
      const head = cells(lines[at]);
      const align = cells(lines[at + 1]).map((rule) => {
        const left = rule.startsWith(":");
        const right = rule.endsWith(":");
        return right && left ? "center" : right ? "right" : left ? "left" : "";
      });
      at += 2;
      const body = [];
      while (at < lines.length && lines[at].includes("|") && lines[at].trim()) body.push(cells(lines[at++]));

      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const hrow = document.createElement("tr");
      head.forEach((text, i) => {
        const th = html("th", inline(escape(text)));
        if (align[i]) th.dataset.align = align[i];
        hrow.appendChild(th);
      });
      thead.appendChild(hrow);
      table.appendChild(thead);
      const tbody = document.createElement("tbody");
      for (const row of body) {
        const tr = document.createElement("tr");
        // Ragged rows are made square: a table with a short row is a table the
        // editor cannot put a caret in the missing half of.
        for (let i = 0; i < head.length; i += 1) {
          const td = html("td", inline(escape(row[i] ?? "")));
          if (align[i]) td.dataset.align = align[i];
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      frag.appendChild(table);
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      frag.appendChild(html(`h${heading[1].length}`, inline(escape(heading[2]))));
      at += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      frag.appendChild(document.createElement("hr"));
      at += 1;
      continue;
    }

    if (/^>/.test(line)) {
      /*
       * One level peeled, then the rest parsed as a document of its own.
       *
       * `> > deeper` is a quote inside a quote, and that nesting is what an
       * indented paragraph *is* in Markdown — the format has no other way to
       * shift a block right, and this is the one it has. Recursion handles the
       * depth and everything inside it: a list in a quote, a quote in a quote,
       * a heading somebody indented.
       */
      const body = [];
      while (at < lines.length && /^>/.test(lines[at])) body.push(lines[at++].replace(/^> ?/, ""));
      const quoted = document.createElement("blockquote");
      quoted.appendChild(fromMarkdown(body.join("\n")));
      frag.appendChild(quoted);
      continue;
    }

    if (bullet(line)) {
      /*
       * A run of list lines, however deep, is one tree.
       *
       * `stack[n]` is the list currently open at depth n — *that* depth, not
       * the one above it. Reading the parent's entry instead was the whole bug
       * in the first version: an indented line found a list of the right kind
       * one level up, decided it belonged there, and every nested bullet in
       * every document came back flat.
       */
      const stack = [];
      while (at < lines.length && bullet(lines[at])) {
        const item = bullet(lines[at++]);
        // A jump of two levels at once is a file written by hand; it lands one
        // deeper than what came before rather than being refused.
        const level = Math.min(item.level, stack.length);
        stack.length = level + 1;

        const wanted = item.ordered ? "OL" : "UL";
        let entry = stack[level];
        if (!entry
            || entry.list.tagName !== wanted
            || (entry.list.dataset.check === "1") !== (item.checked !== null)) {
          const list = document.createElement(wanted.toLowerCase());
          if (item.checked !== null) list.dataset.check = "1";
          // Nested lists live *inside* the item above them, which is the shape
          // `toMarkdown` reads back out — and the shape the browser will keep
          // once it is there.
          if (level === 0 || !stack[level - 1]?.item) frag.appendChild(list);
          else stack[level - 1].item.appendChild(list);
          entry = { list, item: null };
          stack[level] = entry;
        }

        const li = html("li", inline(escape(item.text)));
        if (item.checked !== null) li.dataset.done = item.checked ? "1" : "0";
        entry.list.appendChild(li);
        entry.item = li;
      }
      continue;
    }

    /*
     * A line of arithmetic, kept as characters rather than parsed as prose.
     *
     * `name = value` and anything carrying `=>` are the notation's two shapes.
     * They are given their own paragraph so the editor can find them and so the
     * serializer writes them back untouched; the answer is put on by the
     * calculation pass, which owns it.
     */
    // The same two shapes `calc.js` recognizes, and the same guard against
    // prose: an arrow only makes a line arithmetic when what precedes it could
    // be a sum. See `looksArithmetic` there for why.
    const asks = line.includes("=>")
      && /[+\-*/^%×÷()]|^\s*[\d.,]+\s*$|^\s*[A-Za-z_][A-Za-z0-9_]*\s*$/.test(line.split("=>")[0]);
    if (/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=(?!=)/.test(line) || asks) {
      const calc = document.createElement("p");
      calc.className = "calc";
      calc.textContent = line;
      frag.appendChild(calc);
      at += 1;
      continue;
    }

    // A paragraph: every line up to the next blank one or the next block.
    const body = [];
    while (at < lines.length && lines[at].trim() && !bullet(lines[at])
           && !/^(#{1,3}\s|>|```|-{3,}\s*$|\*{3,}\s*$|_{3,}\s*$)/.test(lines[at])) {
      body.push(lines[at++]);
    }
    frag.appendChild(html("p", body.map((l) => inline(escape(l))).join("<br>") || "<br>"));
  }

  /*
   * An empty document is still a paragraph, and the paragraph still needs a
   * `<br>` in it.
   *
   * A truly empty `<p>` has nothing to put a caret in: focusing the page landed
   * the selection *beside* it, the first line typed became a bare text node at
   * the top level, and — until somebody pressed Enter and the browser wrapped it
   * — it was not a block at all. `blocks()` reads those now as well, but the
   * `<br>` is what stops them happening. It is what every browser puts in an
   * empty paragraph of its own accord.
   */
  if (!frag.childNodes.length) frag.appendChild(html("p", "<br>"));
  return frag;
}

/** Inline nodes, as Markdown. */
function say(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    // Only the characters that would otherwise *become* markup. Escaping every
    // asterisk in sight fills a document with backslashes nobody typed.
    return node.nodeValue.replace(/([*_`~[\]])/g, "\\$1");
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const inner = [...node.childNodes].map(say).join("");
  switch (node.tagName) {
    case "BR": return "\n";
    case "B": case "STRONG": return inner.trim() ? `**${inner}**` : inner;
    case "I": case "EM": return inner.trim() ? `*${inner}*` : inner;
    case "S": case "STRIKE": case "DEL": return inner.trim() ? `~~${inner}~~` : inner;
    case "U": return inner.trim() ? `<u>${inner}</u>` : inner;
    // Backslashes inside a code span would be shown, not read.
    case "CODE": return `\`${node.textContent}\``;
    case "A": return `[${inner}](${node.getAttribute("href") || ""})`;
    default: return inner;
  }
}

/**
 * One list, and everything nested under it.
 *
 * **A nested list is not reliably inside the item above it.** `fromMarkdown`
 * builds it that way, and so does the HTML spec's own advice, but
 * `execCommand("indent")` in Chromium puts the new list *beside* the `li` as
 * another child of the parent list. Both shapes are read here, because both
 * turn up in the same document — one from the file, one from the person typing
 * into it — and a serializer that only knew about the tidy one dropped every
 * nested bullet the moment somebody pressed Tab.
 */
function list(node, depth, out) {
  const checks = node.dataset.check === "1";
  let n = 1;
  for (const child of node.children) {
    if (child.tagName === "UL" || child.tagName === "OL") {
      // A list beside its siblings: it belongs to the item written last.
      list(child, depth + 1, out);
      continue;
    }
    if (child.tagName !== "LI") continue;
    const own = [...child.childNodes].filter((c) => !["UL", "OL"].includes(c.tagName));
    const mark = node.tagName === "OL" ? `${n++}.` : "-";
    const box = checks ? (child.dataset.done === "1" ? "[x] " : "[ ] ") : "";
    out.push(`${"  ".repeat(depth)}${mark} ${box}${own.map(say).join("")}`.trimEnd());
    // And a list inside the item, which is the other shape.
    for (const inner of child.children) {
      if (inner.tagName === "UL" || inner.tagName === "OL") list(inner, depth + 1, out);
    }
  }
}

/** The block kinds that are never inline, whoever produced them. */
const BLOCKS = new Set(["H1", "H2", "H3", "UL", "OL", "PRE", "BLOCKQUOTE", "HR", "P", "DIV", "TABLE"]);

export function toMarkdown(root) {
  const out = [];
  blocks(root, out);
  const text = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  // An empty page is an empty file, not a newline. Anything else and a document
  // that has never been typed into differs from what is on disk, so the first
  // load saves it — which is how opening a blank surface managed to create a
  // file and report "Saved".
  return text ? text + "\n" : "";
}

/**
 * Every block under a node, in order.
 *
 * Separate from `toMarkdown` because it recurses: `execCommand` will happily
 * leave a `<ul>` inside the `<p>` it was made from, and a walker that only
 * looked at the top level serialized that list as a run of unmarked lines —
 * the bullets gone, the text still there, and nothing to say what happened.
 */
function blocks(root, out) {
  for (const node of root.childNodes) {
    // Text nobody wrapped. A contenteditable does that with the first thing
    // typed into it, and until Enter is pressed it is the whole document — so
    // skipping it, as a walk over `children` does, loses the line entirely.
    if (node.nodeType === Node.TEXT_NODE) {
      const loose = say(node).trim();
      if (loose) out.push(loose, "");
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    switch (node.tagName) {
      case "H1": case "H2": case "H3":
        out.push(`${"#".repeat(Number(node.tagName[1]))} ${[...node.childNodes].map(say).join("")}`, "");
        break;
      case "UL": case "OL":
        list(node, 0, out);
        out.push("");
        break;
      case "PRE":
        out.push("```" + (node.querySelector("code")?.dataset.language || ""), node.textContent.replace(/\n$/, ""), "```", "");
        break;
      case "TABLE": {
        const rows = [...node.querySelectorAll("tr")];
        if (!rows.length) break;
        // A pipe inside a cell is escaped, or it would become a column border.
        const say_ = (cell) => [...cell.childNodes].map(say).join("").replace(/\|/g, "\\|").trim();
        const head = [...rows[0].children];
        const width = head.length;
        out.push(`| ${head.map(say_).join(" | ")} |`);
        out.push(`| ${head.map((cell) => {
          const a = cell.dataset.align;
          return a === "center" ? ":---:" : a === "right" ? "---:" : a === "left" ? ":---" : "---";
        }).join(" | ")} |`);
        for (const row of rows.slice(1)) {
          const cells = [...row.children].map(say_);
          while (cells.length < width) cells.push("");
          out.push(`| ${cells.slice(0, width).join(" | ")} |`);
        }
        out.push("");
        break;
      }

      case "BLOCKQUOTE": {
        // Whatever is inside, said as itself and then shifted right one level.
        // A nested blockquote lands here again and is prefixed twice, which is
        // exactly how `> > ` is written.
        const inner = [];
        blocks(node, inner);
        while (inner.length && !inner[inner.length - 1]) inner.pop();
        for (const line of inner) out.push(line ? `> ${line}` : ">");
        out.push("");
        break;
      }
      case "HR":
        out.push("---", "");
        break;
      default: {
        /*
         * A calculation line goes out as it stands.
         *
         * `say()` escapes the characters that would otherwise become markup,
         * and arithmetic is made of them: `rent * 12` would be written
         * `rent \* 12`, which is still true Markdown and is not what anybody
         * typed. The line is marked as arithmetic by the editor, holds no inline
         * formatting by construction, and is therefore safe to write verbatim.
         */
        if (node.classList?.contains("calc")) {
          const text = node.textContent.replace(/\s+$/, "");
          out.push(...(text ? [text] : [""]), "");
          break;
        }
        // A wrapper holding blocks is not a paragraph, whatever its tag says.
        if ([...node.children].some((c) => BLOCKS.has(c.tagName))) {
          blocks(node, out);
          break;
        }
        const text = [...node.childNodes].map(say).join("");
        // An empty paragraph is a blank line somebody put there on purpose.
        out.push(...(text.trim() ? text.split("\n") : [""]), "");
      }
    }
  }
}
