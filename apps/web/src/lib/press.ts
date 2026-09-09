/**
 * What a press landed on.
 *
 * Both panels are driven by presses rather than by where the pointer is
 * hovering, and they have to agree about what a press meant — the left rail
 * opens on the same gesture that puts the right panel away. One vocabulary,
 * read the same way by both.
 */
export type Press =
  /** Inside one of the panels: they own their own insides. */
  | { kind: "panel"; side: "left" | "right" }
  /** A block or a feed event — a thing you can be shown. */
  | { kind: "thing"; id: string }
  /** Something to operate: a button, a field, a menu. Not a place, not a thing. */
  | { kind: "control" }
  /** The page itself. */
  | { kind: "empty" };

/**
 * Anything that answers a press with something other than "look at this" —
 * navigation, a button, a field, a menu, a modal. Deliberately broad: the cost
 * of missing one is a panel opening over what you were about to do, and the
 * cost of including one is that a press there leaves the panels as they are.
 */
const CONTROL =
  'a, button, input, select, textarea, label, summary, [role="button"], [contenteditable="true"],' +
  " .menu, .modal-backdrop, .mention-input, .md-editor, .seg, .bar-btn, .icon-btn, .dtp";

export function classifyPress(target: EventTarget | null): Press {
  const el = target instanceof Element ? target : null;
  if (!el) return { kind: "empty" };
  if (el.closest(".sidebar")) return { kind: "panel", side: "left" };
  if (el.closest(".right-panel")) return { kind: "panel", side: "right" };
  // A thing outranks the controls it contains: a card is covered in buttons and
  // fields, and pressing one is still a press on that card. What it isn't is a
  // press on the page — which is the distinction both panels turn on.
  /*
   * A section's heading is furniture, not the thing under it.
   *
   * The Today page's modules are `<section data-block-id>`, and their headings
   * live inside — so pressing the word EISENHOWER classified as a press on that
   * collection and left the panel alone, while plainly being a press on the
   * page. Nothing in a heading answers a press except the open button, and that
   * is checked for here rather than relied on: `[data-block-id]` outranks
   * controls further down, deliberately, so a button inside a section would
   * otherwise be swallowed by the same rule this is stepping around.
   */
  if (el.closest(".today-h") && !el.closest("button, a")) return { kind: "empty" };

  const thing = el.closest<HTMLElement>("[data-block-id], [data-feed-key]");
  const id = thing?.dataset.blockId || thing?.dataset.feedKey;
  /*
   * A thing's own background is the page, not the thing.
   *
   * A card is mostly padding, and the gaps between the modules on the Today
   * page are inside the sections either side of them. Pressing there landed on
   * `[data-block-id]`, classified as a press on that card, and left the panel
   * alone — so clicking what plainly looks like empty space did nothing at all.
   *
   * `el === thing` is the whole test: a press on a child is a press on the
   * card's contents and still means the card, while a press that stopped at the
   * element itself went through everything and hit the backing. That keeps
   * selecting a card by its blank area working — the card's own click handler
   * fires either way — while letting the panels treat it as the page.
   */
  if (id && el !== thing) return { kind: "thing", id };
  if (el.closest(CONTROL)) return { kind: "control" };
  return { kind: "empty" };
}
