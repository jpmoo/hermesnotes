/*
 * The text inside a canvas note.
 *
 * Hermes' version is its `MarkdownEditor` — tiptap, live WYSIWYG, a Raw/Live
 * toggle and the `@`/`#`/`|` pickers. That is eight packages and about three
 * thousand lines of editor, and Talaria already has the same surface built for
 * the desk's Today pane (`shell/ui/notefield.js`), on the model Hermes' own
 * editor uses: every block rendered except the one the caret is in.
 *
 * **This is a plain textarea for now, and that is a stated gap rather than a
 * decision.** What it costs is live rendering and the pickers *inside a note*;
 * what it keeps is the text, exactly as typed, in the same field Canvas Chat
 * reads. Wiring the desk's field in here is the next step and needs no format
 * change to make — a note is markdown either way.
 */
import { useEffect, useRef } from "react";

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
  const field = useRef<HTMLTextAreaElement>(null);
  const initial = typeof value === "string" ? value : "";

  // Grows with what is in it: a note's box is its size on the canvas and a
  // scrollbar inside one is a note you cannot read at a glance.
  useEffect(() => {
    const node = field.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${node.scrollHeight}px`;
  }, [initial]);

  useEffect(() => {
    if (autofocus) field.current?.focus();
  }, [autofocus]);

  return (
    <div className="longtext">
      <textarea
        ref={field}
        className="longtext-area"
        defaultValue={initial}
        placeholder={placeholder}
        spellCheck={false}
        // The canvas is listening for keys and pointer moves everywhere; a
        // textarea inside it has to keep its own.
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        onFocus={() => onFocusChange?.(true)}
        onBlur={(e) => {
          onFocusChange?.(false);
          onChange(e.currentTarget.value);
        }}
        onInput={(e) => {
          const node = e.currentTarget;
          node.style.height = "auto";
          node.style.height = `${node.scrollHeight}px`;
        }}
      />
    </div>
  );
}
