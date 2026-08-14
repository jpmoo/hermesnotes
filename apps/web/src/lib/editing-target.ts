/**
 * Whether a press landed on something you edit with.
 *
 * Touching a field is not asking to inspect the block it belongs to: picking a
 * value from a pulldown, ticking a box, cycling a status, typing a title — all
 * of it is work on the thing itself, and none of it should open the info panel
 * over the top, or (on a phone) navigate away mid-edit.
 *
 * One list, shared by everything that treats a press as "show me this": the
 * panel's reveal, and the cards and chips that select on click.
 */
const EDITABLE =
  'input, textarea, select, [contenteditable="true"], .md-editor, .mention-input, .status-btn,' +
  // A menu belonging to the field you're writing in — apply a template, send
  // this text forward — is part of the writing. Acting on it shouldn't be read
  // as asking to inspect the block it acts on.
  ' .li-status, .extract-menu, .mention-menu, .ph-menu';

export function isEditingTarget(target: EventTarget | null): boolean {
  const el = target instanceof HTMLElement ? target : null;
  return !!el?.closest?.(EDITABLE);
}
