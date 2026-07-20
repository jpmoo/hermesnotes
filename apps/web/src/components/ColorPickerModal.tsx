import { useEffect, useState } from "react";

const PRESETS = [
  "#5fa4b5", "#3d4247", "#b5525f", "#2f6d4f", "#8a6d1f", "#6a5acd",
  "#c96a3b", "#4a7bb5", "#9aa0a6", "#26282b", "#eef4f6", "#ffffff",
];

// Split an incoming color into a #rrggbb base + alpha (0..1).
function parseColor(value: string): { base: string; alpha: number } {
  if (/^#[0-9a-fA-F]{8}$/.test(value)) {
    return { base: value.slice(0, 7), alpha: parseInt(value.slice(7), 16) / 255 };
  }
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return { base: value, alpha: 1 };
  return { base: "#5fa4b5", alpha: 1 };
}

function compose(base: string, alpha: number): string {
  if (alpha >= 1) return base;
  const a = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0");
  return `${base}${a}`;
}

/** On-theme color picker: native picker + hex + preset swatches + transparency. */
export function ColorPickerModal({
  open,
  title,
  value,
  onCancel,
  onSave,
}: {
  open: boolean;
  title: string;
  value: string;
  onCancel: () => void;
  onSave: (color: string) => void;
}) {
  const [base, setBase] = useState("#5fa4b5");
  const [alpha, setAlpha] = useState(1);

  useEffect(() => {
    if (open) {
      const p = parseColor(value || "#5fa4b5");
      setBase(p.base);
      setAlpha(p.alpha);
    }
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;
  const composed = compose(base, alpha);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">{title}</h2>
        <div className="color-row">
          <input
            type="color"
            className="color-input"
            value={base}
            onChange={(e) => setBase(e.target.value)}
          />
          <div className="swatch-preview" style={{ background: composed }} />
          <input
            type="text"
            className="color-hex"
            value={composed}
            onChange={(e) => {
              const p = parseColor(e.target.value);
              setBase(p.base);
              setAlpha(p.alpha);
            }}
          />
        </div>
        <label className="field" style={{ marginBottom: 14 }}>
          <span>Transparency — {Math.round((1 - alpha) * 100)}%</span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(alpha * 100)}
            onChange={(e) => setAlpha(Number(e.target.value) / 100)}
          />
        </label>
        <div className="swatches">
          {PRESETS.map((p) => (
            <button
              key={p}
              className="swatch"
              style={{ background: p }}
              title={p}
              onClick={() => setBase(p)}
            />
          ))}
        </div>
        <div className="modal-actions">
          <button className="ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="primary" onClick={() => onSave(composed)}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
