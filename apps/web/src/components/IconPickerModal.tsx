import { useEffect, useMemo, useState } from "react";
import { pascalToKebab, useAllIcons } from "../lib/icons.tsx";

const MAX_SHOWN = 300;

/** Searchable modal over the full Lucide set. Returns the kebab-case key. */
export function IconPickerModal({
  open,
  value,
  color,
  onCancel,
  onSelect,
}: {
  open: boolean;
  value: string | null;
  color?: string | null;
  onCancel: () => void;
  onSelect: (iconKey: string) => void;
}) {
  const all = useAllIcons(open);
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  // [kebab, Component] pairs, filtered by the search query.
  const entries = useMemo(() => {
    if (!all) return [];
    const query = q.trim().toLowerCase();
    const out: Array<[string, (typeof all)[string]]> = [];
    for (const name of Object.keys(all)) {
      const kebab = pascalToKebab(name);
      if (query && !kebab.includes(query)) continue;
      out.push([kebab, all[name]!]);
      if (out.length >= MAX_SHOWN) break;
    }
    return out;
  }, [all, q]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal-card icon-picker"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">Choose an icon</h2>
        <input
          type="text"
          placeholder="Search icons…"
          value={q}
          autoFocus
          onChange={(e) => setQ(e.target.value)}
          style={{ marginBottom: 12 }}
        />
        {!all ? (
          <div className="hint">Loading icons…</div>
        ) : (
          <div className="icon-picker-grid">
            {entries.map(([kebab, Icon]) => (
              <button
                key={kebab}
                className={`icon-choice${kebab === value ? " selected" : ""}`}
                title={kebab}
                onClick={() => onSelect(kebab)}
              >
                <Icon size={18} color={color ?? undefined} />
              </button>
            ))}
            {entries.length === 0 && <div className="hint">No matches.</div>}
          </div>
        )}
        <div className="modal-actions" style={{ marginTop: 12 }}>
          <button className="ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
