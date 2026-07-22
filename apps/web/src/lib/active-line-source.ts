import { Extension, Node } from "@tiptap/core";
import { DOMParser as PMDOMParser, Fragment, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type Transaction } from "@tiptap/pm/state";

/**
 * A block that holds the raw markdown source of one block (a `code` node, so
 * ProseMirror skips input rules inside it and no auto-formatting fires). It
 * serializes VERBATIM — its text is exactly the markdown for that block — so
 * having one in the document can never corrupt the saved markdown.
 */
export const SourceBlock = Node.create({
  name: "sourceBlock",
  group: "block",
  content: "text*",
  code: true,
  defining: true,
  marks: "",
  parseHTML() {
    return [{ tag: "pre.source-line", preserveWhitespace: "full" }];
  },
  renderHTML() {
    return ["pre", { class: "source-line" }, ["code", 0]];
  },
  addStorage() {
    return {
      markdown: {
        serialize(state: { text: (t: string, escape: boolean) => void; closeBlock: (n: PMNode) => void }, node: PMNode) {
          state.text(node.textContent, false);
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
});

const KEY = new PluginKey("activeLineSource");
const META = "lineSourceSwap";
const SOURCEABLE = new Set(["paragraph", "heading"]);

type MdStorage = {
  serializer: { serialize: (f: Fragment) => string | undefined };
  parser: { parse: (t: string) => string | unknown };
};

/** Render a markdown string to a document Fragment (empty → an empty paragraph). */
function mdToFragment(schema: Schema, md: MdStorage, text: string): Fragment {
  const html = md.parser.parse(text);
  const div = document.createElement("div");
  div.innerHTML = typeof html === "string" ? html : "";
  const parsed = PMDOMParser.fromSchema(schema).parse(div);
  return parsed.content.size ? parsed.content : Fragment.from(schema.nodes.paragraph!.create());
}

/**
 * Re-chip mentions in place: rendering markdown produces plain `block:`/`tag:`
 * link marks, so convert those back to mention nodes in the given transaction
 * (otherwise a chip decays to a plain link each time its line is rendered).
 */
function rechipMentions(tr: Transaction, schema: Schema): Transaction {
  const linkMark = schema.marks.link;
  const mentionType = schema.nodes.mention;
  if (!linkMark || !mentionType) return tr;
  const ranges: { from: number; to: number; href: string; label: string }[] = [];
  tr.doc.descendants((n, pos) => {
    if (!n.isText) return;
    const link = n.marks.find(
      (m) => m.type === linkMark && /^(block|tag):/.test(String(m.attrs.href ?? "")),
    );
    if (link) ranges.push({ from: pos, to: pos + n.nodeSize, href: link.attrs.href, label: n.text ?? "" });
  });
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i]!;
    tr = tr.replaceWith(r.from, r.to, mentionType.create({ href: r.href, label: r.label }));
  }
  return tr;
}

/** Map a caret offset in the rendered block to a plausible offset in its source. */
function mapOffset(renderedOffset: number, renderedSize: number, sourceLen: number): number {
  if (renderedSize <= 0 || renderedOffset >= renderedSize) return sourceLen;
  if (renderedOffset <= 0) return 0;
  return Math.round((renderedOffset / renderedSize) * sourceLen);
}

/**
 * Obsidian-style live preview: the top-level paragraph/heading containing the
 * cursor shows its editable markdown source; every other block stays rendered.
 * Implemented by swapping the active block to/from a SourceBlock as the cursor
 * moves (lists/quotes/code stay rendered). Enter commits the raw line, rendering
 * it and dropping the cursor onto a fresh source line below.
 */
export const ActiveLineSource = Extension.create({
  name: "activeLineSource",
  // Beat TipTap's core keymap (priority 100): its Enter runs `newlineInCode`
  // first, which fires in any code node — so without this our source-line Enter
  // handler never runs and Enter just inserts a raw newline.
  priority: 1000,

  addKeyboardShortcuts() {
    return {
      Enter: () => {
        const editor = this.editor;
        const { state } = editor;
        const { $head } = state.selection;
        const schema = state.schema;
        const sourceType = schema.nodes.sourceBlock;
        const paraType = schema.nodes.paragraph;
        if (!sourceType || !paraType) return false;
        if ($head.parent.type !== sourceType) return false;

        const md = editor.storage.markdown as MdStorage;
        const text = $head.parent.textContent;
        const offset = $head.parentOffset;
        const before = text.slice(0, offset);
        const after = text.slice(offset);
        const from = $head.before();
        const to = $head.after();

        const rendered = before.trim().length
          ? mdToFragment(schema, md, before)
          : Fragment.from(paraType.create());
        const newSource = sourceType.create(null, after.length ? [schema.text(after)] : []);

        return editor.commands.command(({ tr, dispatch }) => {
          tr.replaceWith(from, to, rendered.append(Fragment.from(newSource)));
          tr = rechipMentions(tr, schema);
          // Cursor onto the fresh source line (just past its opening boundary).
          let sbPos = -1;
          tr.doc.forEach((n, off) => {
            if (n.type === sourceType) sbPos = off;
          });
          if (sbPos >= 0) {
            try {
              tr.setSelection(TextSelection.create(tr.doc, sbPos + 1));
            } catch {
              /* leave as mapped */
            }
          }
          if (dispatch) dispatch(tr);
          return true;
        });
      },
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: KEY,
        appendTransaction(trs, oldState, newState) {
          if (trs.some((tr) => tr.getMeta(META))) return null;
          const selChanged = !oldState.selection.eq(newState.selection);
          const docChanged = trs.some((tr) => tr.docChanged);
          if (!selChanged && !docChanged) return null;

          const schema = newState.schema;
          const sourceType = schema.nodes.sourceBlock;
          const paraType = schema.nodes.paragraph;
          if (!sourceType || !paraType) return null;

          const $head = newState.selection.$head;
          const activeIndex = $head.depth >= 1 ? $head.index(0) : -1;

          // Which top-level blocks need swapping?
          const ops: { from: number; node: PMNode; action: "source" | "render" }[] = [];
          newState.doc.forEach((node, offset, index) => {
            if (node.type === sourceType && index !== activeIndex) {
              ops.push({ from: offset, node, action: "render" });
            } else if (
              index === activeIndex &&
              node.type !== sourceType &&
              SOURCEABLE.has(node.type.name)
            ) {
              ops.push({ from: offset, node, action: "source" });
            }
          });
          if (ops.length === 0) return null;

          const md = editor.storage.markdown as MdStorage;
          let tr = newState.tr;
          // Where to drop the caret inside the block we're turning into source.
          let caretRel = 0;
          // Apply high→low so earlier offsets stay valid.
          for (let i = ops.length - 1; i >= 0; i--) {
            const op = ops[i]!;
            if (op.action === "source") {
              const source = String(md.serializer.serialize(Fragment.from(op.node)) ?? "").replace(
                /\n+$/,
                "",
              );
              caretRel = mapOffset($head.parentOffset, op.node.content.size, source.length);
              const content = source.length ? [schema.text(source)] : [];
              tr = tr.replaceWith(op.from, op.from + op.node.nodeSize, sourceType.create(null, content));
            } else {
              const frag = mdToFragment(schema, md, op.node.textContent);
              tr = tr.replaceWith(op.from, op.from + op.node.nodeSize, frag);
            }
          }

          tr = rechipMentions(tr, schema);

          // Put the cursor inside the (single) source block, near where it was.
          let sbPos = -1;
          let sbNode: PMNode | null = null;
          tr.doc.forEach((n, off) => {
            if (n.type === sourceType) {
              sbPos = off;
              sbNode = n;
            }
          });
          if (sbPos >= 0 && sbNode) {
            const rel = Math.min(caretRel, (sbNode as PMNode).content.size);
            try {
              tr = tr.setSelection(TextSelection.create(tr.doc, sbPos + 1 + rel));
            } catch {
              /* leave selection as mapped */
            }
          }

          tr.setMeta(META, true);
          tr.setMeta("addToHistory", false);
          return tr;
        },
      }),
    ];
  },
});
