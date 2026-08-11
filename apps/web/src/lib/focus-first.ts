/**
 * Put the caret where someone would put it themselves.
 *
 * Making something new is a request to write in it — so the first field it has
 * should already be waiting. Which field that is depends on the type: a title
 * for most, the body for a plain note, whatever comes first for a type built by
 * hand. Rather than encode that, take the first thing in the rendered order that
 * can hold a caret, which is the same one the eye lands on.
 */
const FOCUSABLE = [
  'input:not([type="checkbox"]):not([type="radio"]):not([type="color"]):not([disabled])',
  "textarea:not([disabled])",
  '[contenteditable="true"]',
].join(", ");

export function focusFirstField(root: HTMLElement | null): void {
  if (!root) return;
  const el = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).find(
    // Skip anything rendered but not on screen (a collapsed section, a field
    // behind a tab) — focusing it would scroll to somewhere nobody asked about.
    (n) => n.isContentEditable || n.offsetParent !== null,
  );
  if (!el) return;
  el.focus();
  const input = el as HTMLInputElement;
  if (typeof input.value === "string" && typeof input.setSelectionRange === "function") {
    // After any text that's already there (a default title), not selecting it:
    // typing should extend the name, not silently replace it.
    try {
      input.setSelectionRange(input.value.length, input.value.length);
    } catch {
      /* an input type that has no selection to set */
    }
  }
}

/** The same, once the thing being focused has actually rendered. */
export function focusFirstFieldSoon(get: () => HTMLElement | null): void {
  requestAnimationFrame(() => focusFirstField(get()));
}
