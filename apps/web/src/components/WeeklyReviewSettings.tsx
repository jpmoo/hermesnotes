import { useEffect, useState } from "react";
import { api, ApiError, type BlockType } from "../api.ts";
import { usePreferences } from "../lib/preferences.tsx";
import { reviewApi, WEEKDAYS, type ReviewState } from "../lib/review.ts";
import { ReferenceInput } from "./ReferenceInput.tsx";

/**
 * Weekly-review schedule. Setting a review day creates/updates the recurring
 * "Do weekly review" task and reveals the rail icon; choosing "None" turns the
 * feature off (the icon disappears; any existing task is left in place). The
 * "available" offset is how many days before the due date the review opens.
 */
export function WeeklyReviewSettings() {
  const { refresh } = usePreferences();

  const [weekday, setWeekday] = useState<number | "">("");
  const [prior, setPrior] = useState(0);
  const [project, setProject] = useState<string[]>([]);
  // The task type's project reference type — so this picker matches a task's own.
  const [projectRefTypeId, setProjectRefTypeId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Hydrate straight from the server's review state (authoritative for project),
  // on mount and after each save — no dependence on the preferences round-trip.
  const hydrate = (st: ReviewState) => {
    setWeekday(st.configured ? st.dueWeekday : "");
    setPrior(st.configured ? st.availableDaysPrior : 0);
    setProject(st.configured ? st.project : []);
  };
  useEffect(() => {
    void reviewApi.get().then(hydrate).catch(() => {});
  }, []);

  // Use the exact type the task's Project field references — matches YOUR project
  // type (there can be more than one type named "project"). Find the task type by
  // name or by shape (status + datespan), then its reference field's refTypeId.
  useEffect(() => {
    void api
      .get<BlockType[]>("/block-types")
      .then((types) => {
        const task =
          types.find((t) => t.name.trim().toLowerCase() === "task") ??
          types.find(
            (t) =>
              t.propertySchema?.status_field &&
              t.propertySchema.fields.some((f) => f.type === "datespan"),
          );
        const ref = task?.propertySchema?.fields.find((f) => f.type === "reference" && f.refTypeId);
        setProjectRefTypeId(ref?.refTypeId);
      })
      .catch(() => {});
  }, []);

  const save = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const st = await reviewApi.config(weekday === "" ? null : weekday, prior, project);
      hydrate(st); // reflect exactly what the server saved (incl. project)
      refresh(); // updates the rail-icon gate
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

      {projectRefTypeId && (
        <label className="field" style={{ marginTop: 12 }}>
          <span>Project</span>
          <ReferenceInput
            refTypeId={projectRefTypeId}
            value={project}
            onChange={(v) => setProject(Array.isArray(v) ? v.map(String) : v ? [String(v)] : [])}
          />
          <span className="hint">Files the “Do weekly review” task under a project, like any other task.</span>
        </label>
      )}

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
