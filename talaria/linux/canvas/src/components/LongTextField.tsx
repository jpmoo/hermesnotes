/*
 * The text inside a canvas note — the same editor the desk's Today pane uses.
 *
 * Hermes' version is its `MarkdownEditor`: tiptap, live WYSIWYG, a Raw/Live
 * toggle and the `@`/`#`/`|` pickers. That is eight packages of editor. Talaria
 * already has the same surface, built on the model Hermes' own editor uses —
 * every block rendered except the one the caret is in — and it is *right there*,
 * served from `/ui/notefield.js`, because the shell serves that directory to
 * every page including this one.
 *
 * So it is imported at runtime rather than reimplemented or bundled. Two things
 * follow from that and both are the point: a canvas note and today's note are
 * the same editor, and a fix to one is a fix to both. The import is left to the
 * browser (`@vite-ignore`) because the file is not part of this bundle — it
 * belongs to the shell, which is also what makes it reachable from here at all.
 *
 * Its *styling* is copied into `canvas.css` rather than pulled in with it. The
 * rules live in `panel.css`, which also dresses a body, a pane and a card —
 * names Hermes' canvas is already using for other things — so loading the whole
 * sheet to get sixty lines would be trading a duplication for a collision.
 */
import { useEffect, useRef } from "react";

interface Field {
  text: string;
  set(next: string): void;
}

export function LongTextField({
  value,
  onChange,
  placeholder = "Write…",
  autofocus = false,
  onFocusChange,
}: {
  value: unknown;
  onChange: (value: string) => void;
  placeholder?: string;
  blockId?: string;
  autofocus?: boolean;
  onFocusChange?: (focused: boolean) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const field = useRef<Field | null>(null);
  const latest = useRef<(text: string) => void>(onChange);
  latest.current = onChange;

  useEffect(() => {
    let dead = false;
    const initial = typeof value === "string" ? value : "";
    void (async () => {
      // Through a variable, so the bundler cannot resolve it at build time and
      // try to pull the shell's file into this bundle. It is not ours to bundle:
      // it is served by the shell, to every page, this one included.
      const where = "/ui/notefield.js";
      const mod = (await import(/* @vite-ignore */ where)) as {
        noteField: (host: HTMLElement, text: string, onChange: (t: string) => void) => Field;
      };
      if (dead || !host.current) return;
      field.current = mod.noteField(host.current, initial, (text) => latest.current(text));
      if (autofocus) {
        // The first block, opened for writing: a note somebody has just made
        // should not need a click before it will take words.
        host.current.querySelector<HTMLElement>(".note-block, .note-empty")?.click();
      }
    })();
    return () => {
      dead = true;
    };
    // Mounted once. `EphemeralNote` remounts this by key when the text changes
    // under it, which is how a note edited elsewhere catches up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="longtext"
      ref={host}
      data-placeholder={placeholder}
      // The canvas listens for keys everywhere — Delete removes a node — so
      // nothing typed in here may reach it.
      onKeyDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onFocus={() => onFocusChange?.(true)}
      onBlur={() => onFocusChange?.(false)}
    />
  );
}
