import { Extension } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { LINE_SWAP_META } from "./active-line-source.ts";

/** The two list-item node types in this schema (bullet/ordered vs checklist). */
const ITEM_TYPES = new Set(["listItem", "taskItem"]);
/** The list container types an item can nest. */
const LIST_TYPES = new Set(["bulletList", "orderedList", "taskList"]);

/** The innermost enclosing list-item type at the selection, if any. */
function itemTypeAt(state: EditorState): string | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name;
    if (ITEM_TYPES.has(name)) return name;
  }
  return null;
}

/**
 * Tab / Shift-Tab nest and un-nest the current list item, for every list type —
 * bullet, ordered and checklist alike. The stock behavior comes from each item
 * node's own shortcuts, which differ per type and don't fire from a raw source
 * line; resolving the enclosing item type from the selection instead makes one
 * consistent binding that also works while a line shows its markdown.
 *
 * Returns false outside a list so Tab keeps whatever it does elsewhere.
 */
export const ListIndent = Extension.create({
  name: "listIndent",
  // Above the list-item nodes' own bindings (default 100) so this runs first.
  priority: 200,
  addKeyboardShortcuts() {
    const indent = (lift: boolean) => () => {
      const type = itemTypeAt(this.editor.state);
      if (!type) return false;
      return lift
        ? this.editor.commands.liftListItem(type)
        : this.editor.commands.sinkListItem(type);
    };
    return { Tab: indent(false), "Shift-Tab": indent(true) };
  },
});

const GUTTER_KEY = new PluginKey<number[]>("listGutter");
/** Transaction meta carrying the item position whose fold state should flip. */
const TOGGLE_FOLD = "listGutterToggleFold";

/** The nested lists directly inside a list item, as absolute ranges. */
function nestedLists(item: PMNode, itemPos: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  item.forEach((child, offset) => {
    if (LIST_TYPES.has(child.type.name)) {
      const from = itemPos + 1 + offset;
      out.push({ from, to: from + child.nodeSize });
    }
  });
  return out;
}

/**
 * The list item at `pos`, or null if the position no longer holds one. Each
 * control's decoration key includes its position, so ProseMirror rebuilds the
 * control whenever the item moves and `pos` is current — this only guards
 * against acting on a position the document has since invalidated.
 */
function itemAt(view: EditorView, pos: number): PMNode | null {
  if (pos < 0 || pos > view.state.doc.content.size) return null;
  const node = view.state.doc.nodeAt(pos);
  return node && ITEM_TYPES.has(node.type.name) ? node : null;
}

function buildGrip(view: EditorView, pos: number): HTMLElement {
  const grip = document.createElement("span");
  grip.className = "li-drag";
  grip.draggable = true;
  grip.contentEditable = "false";
  grip.setAttribute("aria-hidden", "true");
  grip.title = "Drag to reorder";
  grip.textContent = "⠿";

  // Select the whole item, then let ProseMirror's own drag-and-drop move it: it
  // already knows how to lift a node out of a list and drop it somewhere valid,
  // which is far safer than hand-rolling the transforms. Because a nested list is
  // a CHILD of its item, selecting the item takes its children along for free.
  const selectItem = () => {
    if (!itemAt(view, pos)) return;
    const sel = view.state.selection;
    if (sel instanceof NodeSelection && sel.from === pos) return; // already ours
    const tr = view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos));
    // The live-preview plugin reshapes the doc on selection changes (swapping the
    // active line to/from raw markdown). It must not run here: that would move
    // positions out from under the drag about to start.
    tr.setMeta(LINE_SWAP_META, true);
    tr.setMeta("addToHistory", false);
    view.dispatch(tr);
  };

  grip.addEventListener("mousedown", (event) => {
    // Keep this from reaching ProseMirror's own mousedown handling, which would
    // otherwise replace the selection we just made.
    event.stopPropagation();
    selectItem();
  });
  // Belt and braces: if a drag begins without our mousedown (touch, synthetic),
  // select the item before ProseMirror reads the selection.
  grip.addEventListener("dragstart", () => selectItem());

  return grip;
}

function buildTwisty(view: EditorView, pos: number, collapsed: boolean): HTMLElement {
  const twisty = document.createElement("span");
  twisty.className = `li-fold${collapsed ? " collapsed" : ""}`;
  twisty.contentEditable = "false";
  twisty.setAttribute("aria-hidden", "true");
  twisty.title = collapsed ? "Expand" : "Collapse";
  twisty.textContent = "▾";
  // Don't let a click here move the caret or start a selection.
  twisty.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  twisty.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!itemAt(view, pos)) return;
    view.dispatch(view.state.tr.setMeta(TOGGLE_FOLD, pos).setMeta("addToHistory", false));
  });
  return twisty;
}

/**
 * The list gutter: a muted grip on every list item that drags it (with anything
 * nested under it) to a new spot, plus a twisty on items that have nested
 * children to fold them away.
 *
 * Both are widget decorations and the fold state lives in plugin state, so the
 * document — and therefore the saved markdown — is never touched. Folding is view
 * state and deliberately isn't persisted: markdown has nowhere to record it, and
 * inventing a place would mean writing to the note just to collapse a row.
 */
export const ListGutter = Extension.create({
  name: "listGutter",
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin<number[]>({
        key: GUTTER_KEY,
        state: {
          init: () => [],
          apply(tr, collapsed) {
            // Follow the items as the document changes around them.
            let next = tr.docChanged
              ? collapsed.map((pos) => tr.mapping.map(pos, 1)).filter((pos) => pos >= 0)
              : collapsed;
            const toggle = tr.getMeta(TOGGLE_FOLD) as number | undefined;
            if (typeof toggle === "number") {
              next = next.includes(toggle)
                ? next.filter((pos) => pos !== toggle)
                : [...next, toggle];
            }
            return next;
          },
        },
        props: {
          decorations(state) {
            if (!editor.isEditable) return DecorationSet.empty; // nothing to drag or fold
            const collapsed = new Set(GUTTER_KEY.getState(state) ?? []);
            const decos: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (!ITEM_TYPES.has(node.type.name)) {
                // Walk through containers (lists, quotes) but not into text.
                return !node.isTextblock;
              }
              const isCollapsed = collapsed.has(pos);
              // The position is part of each key, so the control — and the `pos`
              // its handlers close over — is rebuilt whenever the item moves.
              decos.push(
                Decoration.widget(pos + 1, (view) => buildGrip(view, pos), {
                  side: -1,
                  // The controls aren't content: never let them affect the selection.
                  ignoreSelection: true,
                  key: `li-drag:${pos}`,
                }),
              );
              const kids = nestedLists(node, pos);
              if (kids.length) {
                decos.push(
                  Decoration.widget(pos + 1, (view) => buildTwisty(view, pos, isCollapsed), {
                    side: -2, // ahead of the grip
                    ignoreSelection: true,
                    key: `li-fold:${pos}:${isCollapsed}`,
                  }),
                );
                if (isCollapsed) {
                  for (const kid of kids) {
                    decos.push(Decoration.node(kid.from, kid.to, { class: "li-nested-hidden" }));
                  }
                }
              }
              // A collapsed item's descendants are hidden, so they need nothing.
              return !isCollapsed;
            });
            return decos.length ? DecorationSet.create(state.doc, decos) : DecorationSet.empty;
          },
        },
      }),
    ];
  },
});
