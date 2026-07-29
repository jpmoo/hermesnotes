import { usePreferences } from "../lib/preferences.tsx";

/** Settings card for how lists read inside a note (Settings → Appearance). */
export function ListSettings() {
  const { prefs, setPref } = usePreferences();
  // Opt-out, so an unset preference still shows the stripes.
  const stripes = prefs.list_stripes !== false;

  return (
    <div className="card">
      <h2 className="chrome" style={{ margin: "0 0 4px", fontSize: 15 }}>
        Lists
      </h2>
      <p className="hint" style={{ marginBottom: 14 }}>
        How bulleted, numbered and checklist rows are drawn while you edit a note.
      </p>

      <label className="row bg-opt">
        <input
          type="checkbox"
          checked={stripes}
          onChange={(e) => setPref("list_stripes", e.target.checked)}
        />
        <span>
          Shade alternating rows
          <span className="hint bg-opt-hint"> — a faint band on every other row, to hold your eye on one line</span>
        </span>
      </label>
    </div>
  );
}
