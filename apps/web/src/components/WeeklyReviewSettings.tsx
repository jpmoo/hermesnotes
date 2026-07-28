import { useEffect, useState } from "react";
import { ApiError } from "../api.ts";
import { usePreferences } from "../lib/preferences.tsx";
import { reviewApi, WEEKDAYS } from "../lib/review.ts";

/**
 * Weekly-review schedule. Setting a review day creates/updates the recurring
 * "Do weekly review" task and reveals the rail icon; choosing "None" turns the
 * feature off (the icon disappears; any existing task is left in place). The
 * "available" offset is how many days before the due date the review opens.
 */
export function WeeklyReviewSettings() {
  const { prefs, refresh } = usePreferences();
  const wr = prefs.weekly_review as { dueWeekday?: number | null; availableDaysPrior?: number } | undefined;

  const [weekday, setWeekday] = useState<number | "">("");
  const [prior, setPrior] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Hydrate from the synced preferences (and re-sync after a save).
  useEffect(() => {
    setWeekday(wr?.dueWeekday ?? "");
    setPrior(wr?.availableDaysPrior ?? 0);
  }, [wr?.dueWeekday, wr?.availableDaysPrior]);

  const save = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await reviewApi.config(weekday === "" ? null : weekday, prior);
      refresh(); // updates the rail-icon gate + these fields
      setStatus(weekday === "" ? "Weekly review turned off." : "Weekly review schedule saved.");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "could not save");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="panel-h" style={{ marginTop: 0 }}>Weekly review</div>
      <p className="hint" style={{ marginTop: 0 }}>
        A recurring “Do weekly review” task that walks you through your own steps. Pick the day it’s
        due; it opens a few days earlier if you like. Choose “None” to turn it off.
      </p>

      <label className="field">
        <span>Review day (due)</span>
        <select
          value={weekday === "" ? "" : String(weekday)}
          onChange={(e) => setWeekday(e.target.value === "" ? "" : Number(e.target.value))}
        >
          <option value="">None — off</option>
          {WEEKDAYS.map((d, i) => (
            <option key={i} value={i}>
              {d}
            </option>
          ))}
        </select>
      </label>

      <label className="field" style={{ marginTop: 12 }}>
        <span>Becomes available</span>
        <select value={String(prior)} onChange={(e) => setPrior(Number(e.target.value))} disabled={weekday === ""}>
          <option value="0">On the due day (no early access)</option>
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <option key={n} value={n}>
              {n} day{n > 1 ? "s" : ""} before
            </option>
          ))}
        </select>
        <span className="hint">When a new review opens, the previous one’s checked-off progress resets.</span>
      </label>

      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" onClick={() => void save()} disabled={busy}>
          {busy ? "Saving…" : "Save weekly review"}
        </button>
      </div>
      {status && <div className="hint" style={{ marginTop: 10 }}>{status}</div>}
      {error && <div className="error" style={{ marginTop: 10 }}>{error}</div>}
    </div>
  );
}
