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

/**
 * Gutter geometry, in px, mirroring the list padding in styles.css. Every row's
 * controls are placed in ONE column down the left edge regardless of nesting
 * depth, rather than stepping right with each level — the row striping is what
 * ties a control back to its row, so they don't need to sit beside it.
 *
 * Because a control is positioned within its own row, landing it in that shared
 * column means offsetting it by however far the row is indented, which is why
 * these have to be known here and not just in CSS.
 */
const METRICS = {
  fine: { top: 56, nested: 22, gripX: 3, foldX: 21 },
  coarse: { top: 68, nested: 26, gripX: 3, foldX: 24 },
};

const isCoarsePointer = (): boolean => {
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
};

/** How many lists enclose the item at `pos` (1 = a top-level list). */
function listLevel(state: EditorState, pos: number): number {
  const $pos = state.doc.resolve(pos);
  let level = 0;
  for (let d = 1; d <= $pos.depth; d++) {
    if (LIST_TYPES.has($pos.node(d).type.name)) level++;
  }
  return Math.max(1, level);
}

/** `left` for a control on a row at this nesting level, in its own coordinates. */
function gutterLeft(level: number, which: "grip" | "fold"): number {
  const m = isCoarsePointer() ? METRICS.coarse : METRICS.fine;
  const rowIndent = m.top + (level - 1) * m.nested;
  return (which === "grip" ? m.gripX : m.foldX) - rowIndent;
}

/**
 * Correct the control's offset against the row's real indent once it's laid out.
 * The METRICS above get it right for a plain list, but a checklist carries a
 * slightly different indent (its checkbox is a wider marker), and measuring means
 * the column stays true for any such difference without a second set of constants
 * to keep in sync.
 */
function alignToGutter(el: HTMLElement, view: EditorView, which: "grip" | "fold"): void {
  requestAnimationFrame(() => {
    const li = el.closest("li");
    if (!li || !el.isConnected || !view.dom.isConnected) return;
    const m = isCoarsePointer() ? METRICS.coarse : METRICS.fine;
    // .note-editor has no left padding, so its border edge IS the content edge.
    const indent = li.getBoundingClientRect().left - view.dom.getBoundingClientRect().left;
    el.style.left = `${(which === "grip" ? m.gripX : m.foldX) - indent}px`;
  });
}

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
 * Resolve the row a control belongs to, from the DOM, at the moment it's used.
 *
 * Deliberately not a captured position: keying the decorations by position meant
 * every control in the note was destroyed and rebuilt whenever positions shifted
 * — including on the live-preview line swap that fires as soon as a selection
 * starts — and that DOM churn collapsed any drag-selection across rows. Stable
 * keys keep the elements alive; the position is looked up here instead.
 *
 * `closest("li")` rather than `parentElement` because a checklist renders its
 * content in an inner <div>, so the control can sit at either depth.
 */
function itemPosFor(view: EditorView, el: HTMLElement): number | null {
  const li = el.closest("li");
  if (!li) return null;
  let pos: number;
  try {
    pos = view.posAtDOM(li, 0);
  } catch {
    return null;
  }
  if (pos < 0 || pos > view.state.doc.content.size) return null;
  const $pos = view.state.doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) {
    if (ITEM_TYPES.has($pos.node(d).type.name)) return $pos.before(d);
  }
  return null;
}

/** The list item at `pos`, or null if that position no longer holds one. */
function itemAt(view: EditorView, pos: number): PMNode | null {
  if (pos < 0 || pos > view.state.doc.content.size) return null;
  const node = view.state.doc.nodeAt(pos);
  return node && ITEM_TYPES.has(node.type.name) ? node : null;
}

// ── Touch reordering ─────────────────────────────────────────────────────────
// Touch devices never fire HTML5 drag events, so the grip's native drag-and-drop
// is mouse-only. These handlers reproduce it: track the finger, show where the
// row would land, and move the node on release.

let dropLine: HTMLElement | null = null;

/** Show (creating if needed) the line marking where the row would land. */
function showDropLine(view: EditorView, target: number): void {
  if (!dropLine) {
    dropLine = document.createElement("div");
    dropLine.className = "li-drop-line";
    document.body.appendChild(dropLine);
  }
  let coords: { top: number; bottom: number };
  try {
    coords = view.coordsAtPos(target);
  } catch {
    return;
  }
  const box = view.dom.getBoundingClientRect();
  dropLine.style.top = `${coords.top}px`;
  dropLine.style.left = `${box.left}px`;
  dropLine.style.width = `${box.width}px`;
}

function hideDropLine(): void {
  dropLine?.remove();
  dropLine = null;
}

/**
 * Where a row released at these viewport coordinates should be inserted, or null
 * if that isn't a legal home for it. Only items of the SAME type are considered,
 * so a checklist row can't be dropped among bullets (which the schema forbids)
 * and a drop inside the row being dragged is refused.
 */
function dropTargetAt(view: EditorView, x: number, y: number, dragPos: number): number | null {
  const dragged = itemAt(view, dragPos);
  if (!dragged) return null;
  const at = view.posAtCoords({ left: x, top: y });
  if (!at) return null;
  const $pos = view.state.doc.resolve(at.pos);
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (node.type.name !== dragged.type.name) continue;
    const itemPos = $pos.before(d);
    // Refuse to drop a row into itself or its own subtree.
    if (itemPos >= dragPos && itemPos < dragPos + dragged.nodeSize) return null;
    const dom = view.nodeDOM(itemPos);
    const rect = dom instanceof HTMLElement ? dom.getBoundingClientRect() : null;
    const below = rect ? y > rect.top + rect.height / 2 : false;
    return below ? itemPos + node.nodeSize : itemPos;
  }
  return null;
}

/** Move the row at `from` to the insertion point `to`. */
function moveItem(view: EditorView, from: number, to: number): void {
  const node = itemAt(view, from);
  if (!node) return;
  if (to >= from && to <= from + node.nodeSize) return; // no-op
  const tr = view.state.tr;
  tr.delete(from, from + node.nodeSize);
  const insertAt = tr.mapping.map(to, -1);
  try {
    tr.insert(insertAt, node);
  } catch {
    return; // not a legal spot after all — leave the document alone
  }
  // Keep the live-preview plugin from reshaping things around the move.
  tr.setMeta(LINE_SWAP_META, true);
  view.dispatch(tr);
}

function buildGrip(view: EditorView, level: number): HTMLElement {
  const grip = document.createElement("span");
  grip.className = "li-drag";
  grip.style.left = `${gutterLeft(level, "grip")}px`;
  alignToGutter(grip, view, "grip");
  grip.draggable = true;
  grip.contentEditable = "false";
  grip.setAttribute("aria-hidden", "true");
  grip.title = "Drag to reorder";
  grip.textContent = "⠿";

  // Mouse: select the whole item, then hand off to ProseMirror's own
  // drag-and-drop, which already knows how to lift a node out of a list and drop
  // it somewhere schema-valid — far safer than hand-rolling the transforms.
  // Because a nested list is a CHILD of its item, selecting the item takes its
  // children along for free.
  const selectItem = () => {
    const pos = itemPosFor(view, grip);
    if (pos == null || !itemAt(view, pos)) return;
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
  grip.addEventListener("dragstart", () => selectItem());

  // Touch: drive the move ourselves. The row is resolved once at gesture start
  // and held for the duration, so the move lands where the drag began.
  let target: number | null = null;
  let from: number | null = null;
  let row: HTMLElement | null = null;
  grip.addEventListener(
    "touchstart",
    (event) => {
      const pos = itemPosFor(view, grip);
      if (pos == null || !itemAt(view, pos)) return;
      // Claim the gesture so the page doesn't scroll or start selecting text.
      event.preventDefault();
      event.stopPropagation();
      from = pos;
      target = null;
      grip.classList.add("dragging");
      // Outline the row via a class rather than selecting it: a selection would
      // focus the editor and raise the on-screen keyboard in the middle of a drag.
      const dom = view.nodeDOM(pos);
      row = dom instanceof HTMLElement ? dom : null;
      row?.classList.add("li-dragging");
    },
    { passive: false },
  );
  grip.addEventListener(
    "touchmove",
    (event) => {
      if (from == null) return;
      event.preventDefault();
      const touch = event.touches[0];
      if (!touch) return;
      target = dropTargetAt(view, touch.clientX, touch.clientY, from);
      if (target == null) hideDropLine();
      else showDropLine(view, target);
    },
    { passive: false },
  );
  const endTouch = (event: Event) => {
    if (from == null) return;
    event.preventDefault();
    grip.classList.remove("dragging");
    row?.classList.remove("li-dragging");
    row = null;
    hideDropLine();
    if (target != null) moveItem(view, from, target);
    from = null;
    target = null;
  };
  grip.addEventListener("touchend", endTouch, { passive: false });
  grip.addEventListener("touchcancel", endTouch, { passive: false });

  return grip;
}

function buildTwisty(view: EditorView, level: number, collapsed: boolean): HTMLElement {
  const twisty = document.createElement("span");
  twisty.className = `li-fold${collapsed ? " collapsed" : ""}`;
  twisty.style.left = `${gutterLeft(level, "fold")}px`;
  alignToGutter(twisty, view, "fold");
  twisty.contentEditable = "false";
  twisty.setAttribute("aria-hidden", "true");
  twisty.title = collapsed ? "Expand" : "Collapse";
  twisty.textContent = "▾";
  const toggle = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    const pos = itemPosFor(view, twisty);
    if (pos == null || !itemAt(view, pos)) return;
    view.dispatch(view.state.tr.setMeta(TOGGLE_FOLD, pos).setMeta("addToHistory", false));
  };
  // Don't let a tap here move the caret or start a selection.
  twisty.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  twisty.addEventListener("click", toggle);
  // Touch gets its own binding: waiting for the synthesized click adds a delay,
  // and the surrounding editor may claim the gesture first.
  twisty.addEventListener("touchend", toggle, { passive: false });
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
              const level = listLevel(state, pos);
              // Keys carry no position on purpose: ProseMirror reuses a widget
              // whose key is unchanged, so editing elsewhere in the note doesn't
              // tear down and rebuild every control. Rebuilding them mid-gesture
              // used to collapse drag-selections across rows. The nesting level IS
              // in the key, since it decides the control's offset — and it only
              // changes when the row is actually indented or outdented.
              decos.push(
                Decoration.widget(pos + 1, (view) => buildGrip(view, level), {
                  side: -1,
                  // The controls aren't content: never let them affect the selection.
                  ignoreSelection: true,
                  key: `li-drag:${level}`,
                }),
              );
              const kids = nestedLists(node, pos);
              if (kids.length) {
                decos.push(
                  Decoration.widget(pos + 1, (view) => buildTwisty(view, level, isCollapsed), {
                    side: -2, // ahead of the grip
                    ignoreSelection: true,
                    key: `li-fold:${level}:${isCollapsed}`,
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
