import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

/**
 * Bare URLs, clickable in live preview.
 *
 * Read-only notes already do this: `Markdown.tsx` runs remark-gfm, and GFM
 * autolinks a bare address. The editor did not, so the same note was a link in
 * one place and dead text in the other — and the difference was invisible until
 * somebody clicked.
 *
 * A **decoration**, not a link mark. Marking would mean the markdown itself
 * changed the moment a note was opened: prosemirror-markdown serializes a plain
 * autolink as `<https://…>`, so every note holding a bare address would be
 * rewritten on load by a feature nobody asked to have rewrite anything. A
 * decoration is drawn over the text and touches nothing underneath it — the
 * file on disk is the file the person wrote.
 *
 * The anchor it draws is a real `<a href>`, which is what makes the existing
 * mousedown handler in `MarkdownEditor` open it: that handler looks for
 * `a[href]` and does not care who put it there.
 */

/*
 * Deliberately narrow. `www.` and a scheme, nothing else — no bare `example.com`,
 * which would turn "e.g." and every sentence ending in a file extension into a
 * link. The trailing class excludes the punctuation that ends a sentence rather
 * than a URL, and a closing bracket is only kept when the URL opened one.
 */
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;

/** The address without the punctuation that belonged to the sentence. */
function trim(found: string): string {
  let url = found;
  for (;;) {
    const last = url[url.length - 1] ?? "";
    if (".,;:!?".includes(last)) {
      url = url.slice(0, -1);
      continue;
    }
    // A bracket that nothing in the URL opened is the sentence's, not the
    // address's — but `…/Foo_(bar)` is a real Wikipedia link and keeps its own.
    if (last === ")" && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === "]" && (url.match(/\[/g)?.length ?? 0) < (url.match(/\]/g)?.length ?? 0)) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

function decorate(doc: PMNode, linkName: string): DecorationSet {
  const found: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    // Already a link — or code, where a URL is a string being shown rather than
    // an address being offered.
    if (node.marks.some((m) => m.type.name === linkName || m.type.name === "code")) return;
    if (node.text.startsWith("attach:") || node.text.startsWith("import:")) return;
    for (const match of node.text.matchAll(URL_RE)) {
      const url = trim(match[0]);
      if (!url) continue;
      const at = match.index ?? 0;
      found.push(
        Decoration.inline(pos + at, pos + at + url.length, {
          nodeName: "a",
          href: url.startsWith("www.") ? `https://${url}` : url,
          class: "auto-url",
          rel: "noreferrer",
        }),
      );
    }
  });
  return DecorationSet.create(doc, found);
}

export const AutoUrl = Extension.create({
  name: "autoUrl",

  addProseMirrorPlugins() {
    const linkName = this.editor.schema.marks.link?.name ?? "link";
    return [
      new Plugin({
        key: new PluginKey("autoUrl"),
        state: {
          init: (_config, state) => decorate(state.doc, linkName),
          // Only when the text changed. A caret move redraws nothing, which
          // matters: the active-line extension swaps a paragraph to raw source
          // on every selection change, and rescanning the document each time
          // would be the whole note, per keystroke, per arrow key.
          apply: (tr, old) => (tr.docChanged ? decorate(tr.doc, linkName) : old),
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
      }),
    ];
  },
});
