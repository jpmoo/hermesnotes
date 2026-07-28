import { mergeAttributes, Node, type Editor } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { MentionChip } from "../components/MentionChip.tsx";

/**
 * An inline mention chip (person / block / tag). Stored in markdown as a link
 * `[label](block:<id>)` or `[label](tag:<name>)` so it round-trips as plain
 * markdown; rendered in the editor as an icon-prefixed clickable chip.
 */
export const MentionNode = Node.create({
  name: "mention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      href: { default: "" },
      label: { default: "" },
    };
  },

  parseHTML() {
    return [
      {
        tag: "a[data-mention]",
        getAttrs: (el) => ({
          href: (el as HTMLElement).getAttribute("href"),
          label: (el as HTMLElement).textContent,
        }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "a",
      mergeAttributes(HTMLAttributes, { "data-mention": "", href: node.attrs.href }),
      node.attrs.label,
    ];
  },

  renderText({ node }) {
    return node.attrs.label as string;
  },

  addNodeView() {
    return ReactNodeViewRenderer(MentionChip);
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: { write: (s: string) => void }, node: { attrs: { label: string; href: string } }) {
          state.write(`[${escapeLabel(node.attrs.label)}](${node.attrs.href})`);
        },
        parse: {},
      },
    };
  },
});

/**
 * Make a label safe inside `[...]`. An unescaped `]` would close the link early
 * — so a label like `x](https://evil)` would serialize into a *different*,
 * attacker-chosen link on the next parse — and a raw newline breaks the link
 * apart entirely (multi-line selections are the norm for extract-to-block).
 */
export function escapeLabel(label: string): string {
  return String(label ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

/**
 * Convert markdown-parsed link marks whose href is `block:`/`tag:` into mention
 * nodes (tiptap-markdown parses them as plain links on load). Run after content
 * loads / after a raw→live toggle.
 */
export function linksToMentions(ed: Editor): void {
  const linkMark = ed.schema.marks.link;
  const mentionType = ed.schema.nodes.mention;
  if (!linkMark || !mentionType) return;
  const ranges: { from: number; to: number; href: string; label: string }[] = [];
  ed.state.doc.descendants((n, pos) => {
    if (!n.isText) return;
    const link = n.marks.find(
      (m) => m.type === linkMark && /^(block|tag):/.test(String(m.attrs.href ?? "")),
    );
    if (link) ranges.push({ from: pos, to: pos + n.nodeSize, href: link.attrs.href, label: n.text ?? "" });
  });
  if (ranges.length === 0) return;
  const tr = ed.state.tr;
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i]!;
    tr.replaceWith(r.from, r.to, mentionType.create({ href: r.href, label: r.label }));
  }
  tr.setMeta("addToHistory", false);
  tr.setMeta("mentionConvert", true);
  ed.view.dispatch(tr);
}
