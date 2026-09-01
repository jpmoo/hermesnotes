/**
 * Copy / cut / paste for a text field whose own right-click menu we've taken
 * over.
 *
 * A canvas node answers right-clicks with its own menu — color, convert,
 * remove — which means the browser's menu never appears, and with it goes the
 * one place copy and paste live. So the menu has to carry them itself.
 *
 * Two wrinkles make this more than calling execCommand. Clicking a menu button
 * takes focus off the field and drops its selection, so what was selected has
 * to be recorded when the menu opens and put back before the edit runs. And the
 * fields are React-controlled: writing to `.value` would be painted over on the
 * next render, so edits go through `insertText`, which produces a real input
 * event (and stays on the field's own undo stack).
 */

type Editable = HTMLInputElement | HTMLTextAreaElement;

export interface FieldSelection {
  el: HTMLElement;
  /** Caret bounds for an input/textarea; a live Range for contenteditable. */
  start: number;
  end: number;
  range: Range | null;
  /** The selected text — empty when the click was just a caret placement. */
  text: string;
  /** False for a read-only or disabled field: it can be copied from, not into. */
  writable: boolean;
}

const isEditable = (el: HTMLElement): el is Editable =>
  el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && /^(text|search|url|email|tel|number|password)$/.test(el.type));

/** What's selected in the field under `target`, or null if that isn't a field. */
export function captureField(target: EventTarget | null): FieldSelection | null {
  const el = target instanceof HTMLElement ? target : null;
  if (!el) return null;
  if (isEditable(el)) {
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    return {
      el,
      start,
      end,
      range: null,
      text: el.value.slice(start, end),
      writable: !el.readOnly && !el.disabled,
    };
  }
  const host = el.closest<HTMLElement>('[contenteditable="true"]');
  if (!host) return null;
  const sel = window.getSelection();
  const range = sel && sel.rangeCount > 0 && host.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
  return { el: host, start: 0, end: 0, range, text: range ? range.toString() : "", writable: true };
}

/** Put the caret back where it was before the menu stole focus. */
function restore(f: FieldSelection) {
  f.el.focus();
  if (isEditable(f.el)) {
    f.el.setSelectionRange(f.start, f.end);
    return;
  }
  if (!f.range) return;
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(f.range);
}

async function toClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // No clipboard permission (or an insecure origin): the old command still
    // works on a live selection, which is exactly what we have here.
    document.execCommand("copy");
  }
}

async function fromClipboard(): Promise<string | null> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    // Reading is the guarded half. Where it's refused, the built-in paste
    // command may still be allowed (it is in the desktop wrapper) — and where
    // that's refused too, it's a harmless no-op.
    document.execCommand("paste");
    return null;
  }
}

export async function runFieldClipboard(f: FieldSelection, action: "copy" | "cut" | "paste"): Promise<void> {
  restore(f);
  if (action === "copy") {
    await toClipboard(f.text);
    return;
  }
  if (action === "cut") {
    await toClipboard(f.text);
    restore(f); // the await gave the field a chance to lose focus again
    document.execCommand("delete");
    return;
  }
  const text = await fromClipboard();
  if (text == null) return; // execCommand already pasted, or there was nothing
  restore(f);
  document.execCommand("insertText", false, text);
}
