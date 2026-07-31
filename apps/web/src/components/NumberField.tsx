import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useState } from "react";

/** Numbers only, allowing a lone "-" or trailing "." while still being typed. */
const NUMERIC = /^-?\d*\.?\d*$/;

/**
 * A short numeric field: a narrow box that refuses non-numbers, a stacked
 * up/down pair to nudge the value, and an optional unit shown after it
 * ("30 minutes").
 *
 * An empty field shows a dash and stores NOTHING — the dash is presentation only
 * (a placeholder), so what reaches the API, MCP and the assistant is a number or
 * null, never "-". Stepping an empty field counts from zero, so the first press
 * gives 1 or -1.
 *
 * Once it holds a number there's a clear button back to that empty state. The
 * rocker can only ever land on a number, and "no value" is a different thing
 * from zero — without this the only way back was to select the text and delete
 * it, which isn't a route anyone finds (and is fiddly on a phone).
 */
export function NumberField({
  value,
  onChange,
  units,
}: {
  value: unknown;
  onChange: (value: number | null) => void;
  units?: string;
}) {
  const stored = typeof value === "number" && Number.isFinite(value) ? value : null;
  const [text, setText] = useState(stored === null ? "" : String(stored));
  const [focused, setFocused] = useState(false);

  // Follow the stored value when it changes elsewhere — but never mid-edit, which
  // would fight the caret and swallow a half-typed "-" or "1.".
  useEffect(() => {
    if (!focused) setText(stored === null ? "" : String(stored));
  }, [stored, focused]);

  const commit = (next: string) => {
    if (!NUMERIC.test(next)) return; // reject the keystroke outright
    setText(next);
    // Cleared, or nothing but a minus sign yet: the field holds no number.
    if (next === "" || next === "-") return onChange(null);
    const n = Number(next);
    if (Number.isFinite(n)) onChange(n);
  };

  const step = (delta: number) => {
    const n = (stored ?? 0) + delta;
    setText(String(n));
    onChange(n);
  };

  return (
    <span className="num-field">
      <input
        className="num-input"
        type="text"
        inputMode="decimal"
        autoComplete="off"
        /* The dash lives here rather than in the value, so it can never be saved. */
        placeholder="-"
        value={text}
        onChange={(e) => commit(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          setText(stored === null ? "" : String(stored)); // tidy "1." / "-" away
        }}
      />
      {stored !== null && (
        <button
          type="button"
          className="num-clear"
          title="Clear"
          onClick={() => {
            setText("");
            onChange(null);
          }}
        >
          <X size={12} />
        </button>
      )}
      <span className="num-steps">
        <button type="button" className="num-step" title="Increase" onClick={() => step(1)}>
          <ChevronUp size={11} />
        </button>
        <button type="button" className="num-step" title="Decrease" onClick={() => step(-1)}>
          <ChevronDown size={11} />
        </button>
      </span>
      {units && <span className="num-units">{units}</span>}
    </span>
  );
}
