import { MarkdownEditor } from "./MarkdownEditor.tsx";

/**
 * A paragraph-sized markdown editor field (`longtext`): the same surface as a
 * note body — live WYSIWYG with a Raw/Live toggle, links, and @/#/| mentions.
 */
export function LongTextField({
  value,
  onChange,
  placeholder = "Write…",
  blockId,
  autofocus = false,
  onFocusChange,
}: {
  value: unknown;
  onChange: (value: string) => void;
  placeholder?: string;
  blockId?: string;
  /** Put the caret in it on mount (something just created it). */
  autofocus?: boolean;
  onFocusChange?: (focused: boolean) => void;
}) {
  const initial = typeof value === "string" ? value : "";
  return (
    <div className="longtext">
      <MarkdownEditor
        value={initial}
        onChange={onChange}
        placeholder={placeholder}
        blockId={blockId}
        autofocus={autofocus}
        onFocusChange={onFocusChange}
      />
    </div>
  );
}
