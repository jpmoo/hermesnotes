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
  const thing = el.closest<HTMLElement>("[data-block-id], [data-feed-key]");
  const id = thing?.dataset.blockId || thing?.dataset.feedKey;
  if (id) return { kind: "thing", id };
  if (el.closest(CONTROL)) return { kind: "control" };
  return { kind: "empty" };
}
