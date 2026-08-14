import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { isCaretLine } from "@hermes/shared";

/**
 * Hide the caret mark in live preview.
 *
 * A template can leave a line holding nothing but `/` to say where writing
 * starts. It has a job to do — the field opens with the caret on it — but it's
 * scaffolding, and reading a stray slash under every heading is noise. So the
 * line keeps its place and loses its glyph: the text goes transparent rather
 * than being removed, which keeps the line's height, keeps the caret landing
 * where it should, and leaves the mark visible in raw view where you're looking
 * at the source anyway.
 *
 * A decoration rather than a rewrite, so nothing about the stored text changes:
 * the slash is still there, still selected when the field opens, and still
 * replaced by the first thing typed.
 */
export const CaretSlot = Extension.create({
  name: "caretSlot",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations(state) {
            const found: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (!node.isTextblock) return;
              if (!isCaretLine(node.textContent)) return;
              found.push(Decoration.node(pos, pos + node.nodeSize, { class: "caret-slot" }));
            });
            return found.length ? DecorationSet.create(state.doc, found) : null;
          },
        },
      }),
    ];
  },
});
