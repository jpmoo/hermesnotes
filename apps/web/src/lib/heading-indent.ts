import { Extension, InputRule } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/**
 * Create a checkbox from `[ ] `, `[x] `, or `- [ ] ` (the dash first becomes a
 * bullet, then this converts that bullet list to a task list). Covers the cases
 * the built-in task-item rule misses.
 */
export const CheckboxInput = Extension.create({
  name: "checkboxInput",
  addInputRules() {
    return [
      new InputRule({
        // Matches "[ ] ", "[x] ", and a leading-dash form "- [ ] " (whether or
        // not the dash already became a bullet).
        find: /^\s*(?:[-*+]\s+)?\[([ xX]?)\]\s$/,
        handler: ({ range, match, chain }) => {
          const checked = /[xX]/.test(match[1] ?? "");
          chain()
            .deleteRange(range)
            .toggleTaskList()
            .updateAttributes("taskItem", { checked })
            .run();
        },
      }),
    ];
  },
});

/** Deepest outline level with an indent rule in the stylesheet (see .hi-N). */
const MAX_OUTLINE = 6;

/**
 * The heading level a top-level block contributes, or null if it isn't a
 * heading. Handles both a rendered heading node and a heading being edited as a
 * raw source line (`### …`), so indentation stays stable across the swap.
 */
function headingLevelOf(node: { type: { name: string }; attrs: Record<string, unknown>; textContent: string }): number | null {
  if (node.type.name === "heading") return node.attrs.level as number;
  if (node.type.name === "sourceBlock") {
    const m = /^(#{1,6})\s/.exec(node.textContent);
    if (m) return m[1]!.length;
  }
  return null;
}

/**
 * Live-preview outline indentation: a heading sits at its own level and what
 * follows it sits one step inside, so a section reads as something the heading
 * holds rather than a run of lines that happens to come after it. A deeper
 * heading lands in the column its parent's text uses — it is one of the things
 * that section contains — and takes its own content a step further in again:
 *
 *     ## Trip              <- indent 0
 *       packing list       <- indent 1
 *       ### Suitcase       <- indent 1
 *         shirts           <- indent 2
 *
 * The shallowest heading present sits at the margin, and a blank line clears the
 * indent. Purely visual (decorations); the stored markdown is untouched.
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
              const lvl = headingLevelOf(node);
              if (lvl != null) minLevel = Math.min(minLevel, lvl);
            });

            const decos: Decoration[] = [];
            let contentIndent = 0;
            doc.forEach((node, offset) => {
              const lvl = headingLevelOf(node);
              const isEmpty =
                (node.type.name === "paragraph" && node.content.size === 0) ||
                (node.type.name === "sourceBlock" && node.textContent.length === 0);

              let indent = 0;
              if (lvl != null) {
                indent = Math.max(0, lvl - minLevel);
                // One step inside the heading: the section is held by it, not
                // merely underneath it. A deeper heading then lands in the same
                // column as the text it sits among, which is what it is.
                contentIndent = indent + 1;
              } else if (isEmpty) {
                // An empty line (blank paragraph) clears the indent.
                indent = 0;
                contentIndent = 0;
              } else {
                // Sticky: every block under the heading keeps its indent until
                // the next heading or a blank line.
                indent = contentIndent;
              }
              if (indent > 0) {
                // A class, not an inline margin: the stylesheet pairs the shift
                // with a matching --outline-indent, which a list's gutter reads so
                // its controls and row banding can back the shift out and still
                // line up with the note's left edge (see .hi-N in styles.css).
                decos.push(
                  Decoration.node(offset, offset + node.nodeSize, {
                    class: `hi-${Math.min(indent, MAX_OUTLINE)}`,
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
