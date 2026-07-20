import { useEffect, useState } from "react";

const PRESETS = [
  "#5fa4b5", "#3d4247", "#b5525f", "#2f6d4f", "#8a6d1f", "#6a5acd",
  "#c96a3b", "#4a7bb5", "#9aa0a6", "#26282b", "#eef4f6", "#ffffff",
];

/** On-theme color picker in a modal: native picker + hex field + preset swatches. */
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
  const [color, setColor] = useState(value || "#5fa4b5");

  useEffect(() => {
    if (open) setColor(value || "#5fa4b5");
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

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">{title}</h2>
        <div className="color-row">
          <input
            type="color"
            className="color-input"
            value={color}
            onChange={(e) => setColor(e.target.value)}
          />
          <input
            type="text"
            className="color-hex"
            value={color}
            onChange={(e) => setColor(e.target.value)}
          />
        </div>
        <div className="swatches">
          {PRESETS.map((p) => (
            <button
              key={p}
              className="swatch"
              style={{ background: p }}
              title={p}
              onClick={() => setColor(p)}
            />
          ))}
        </div>
        <div className="modal-actions">
          <button className="ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="primary" onClick={() => onSave(color)}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
