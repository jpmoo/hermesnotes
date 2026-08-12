import { useEffect, useRef, useState } from "react";
import { LongTextField } from "./LongTextField.tsx";

/**
 * The text of an ephemeral canvas note — the same markdown surface as a
 * `longtext` field, so a note formats and renders like every other piece of
 * prose in Hermes: headings, lists, checkboxes, links, @/#/| mentions, and the
 * Raw/Live toggle.
 *
 * A note has two surfaces (its box on the canvas and the editor in the info
 * panel) and the markdown editor owns its document once mounted, so a change
 * made on the other surface can only be taken by remounting with the new text.
 * That's held while you're typing here — otherwise the sentence you're in would
 * be replaced under the caret — and applied as soon as you leave.
 */
export function EphemeralNote({
  text,
  onChange,
  placeholder = "Write…",
  autofocus = false,
  onFocusChange,
}: {
  text: string;
  onChange: (text: string) => void;
  placeholder?: string;
  autofocus?: boolean;
  onFocusChange?: (focused: boolean) => void;
}) {
  const [nonce, setNonce] = useState(0);
  const focused = useRef(false);
  // The last text this surface itself produced: anything else is foreign.
  const mine = useRef(text);

  const adopt = (next: string) => {
    if (next === mine.current) return;
    mine.current = next;
    setNonce((n) => n + 1);
  };
  useEffect(() => {
    if (focused.current) return;
    adopt(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  return (
    <LongTextField
      key={nonce}
      value={text}
      placeholder={placeholder}
      autofocus={autofocus}
      onChange={(v) => {
        mine.current = v;
        onChange(v);
      }}
      onFocusChange={(f) => {
        focused.current = f;
        if (!f) adopt(text); // catch up on whatever arrived while typing
        onFocusChange?.(f);
      }}
    />
  );
}
