import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

const STEP_EM = 1.5;

/**
 * Live-preview outline indentation: each block is indented under the most recent
 * heading (deeper headings nest further). A new paragraph — i.e. a double line
 * break (see SmartEnter) — resets back to the left margin. Purely visual
 * (decorations); the stored markdown is untouched.
 */
export const HeadingIndent = Extension.create({
  name: "headingIndent",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("headingIndent"),
        props: {
          decorations(state) {
            const doc = state.doc;

            // Normalize so the shallowest heading present sits at indent 0.
            let minLevel = 6;
            doc.forEach((node) => {
              if (node.type.name === "heading") {
                minLevel = Math.min(minLevel, node.attrs.level as number);
              }
            });

            const decos: Decoration[] = [];
            let contentIndent = 0;
            let prevWasContent = false;
            doc.forEach((node, offset) => {
              let indent = 0;
              if (node.type.name === "heading") {
                indent = Math.max(0, (node.attrs.level as number) - minLevel);
                contentIndent = indent + 1;
                prevWasContent = false;
              } else {
                // A content block after another content block is a fresh
                // paragraph (double line break) → back to the margin.
                if (prevWasContent) contentIndent = 0;
                indent = contentIndent;
                prevWasContent = true;
              }
              if (indent > 0) {
                decos.push(
                  Decoration.node(offset, offset + node.nodeSize, {
                    style: `padding-left:${(indent * STEP_EM).toFixed(2)}em`,
                  }),
                );
              }
            });

            return DecorationSet.create(doc, decos);
          },
        },
      }),
    ];
  },
});

/**
 * Enter inserts a soft line break (stays in the block, no blank line, same
 * indent). Enter on an already-broken/empty line splits into a new paragraph —
 * the "double line break" that clears the indent. Lists/headings keep default
 * Enter behavior.
 */
export const SmartEnter = Extension.create({
  name: "smartEnter",
  addKeyboardShortcuts() {
    return {
      Enter: () => {
        const editor = this.editor;
        const { $from } = editor.state.selection;
        if ($from.parent.type.name !== "paragraph") return false;

        const parentContainer = $from.node($from.depth - 1);
        if (
          parentContainer &&
          (parentContainer.type.name === "listItem" || parentContainer.type.name === "taskItem")
        ) {
          return false; // lists manage their own Enter
        }

        const before = $from.nodeBefore;
        const afterHardBreak = !!before && before.type.name === "hardBreak";
        const emptyParagraph = $from.parent.content.size === 0;

        if (afterHardBreak) {
          return editor
            .chain()
            .deleteRange({ from: $from.pos - before.nodeSize, to: $from.pos })
            .splitBlock()
            .run();
        }
        if (emptyParagraph) {
          return editor.commands.splitBlock();
        }
        return editor.commands.setHardBreak();
      },
    };
  },
});
