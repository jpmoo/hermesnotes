import type { Recurrence } from "@hermes/shared";
import { DateTimePicker } from "./DateTimePicker.tsx";
import { Repeat } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
type Freq = Recurrence["frequency"];
const UNIT: Record<Freq, string> = { daily: "day", weekly: "week", monthly: "month", yearly: "year" };

const defaultRecurrence = (): Recurrence => ({
  completeFrom: "scheduled",
  frequency: "weekly",
  interval: 1,
  weekdays: [new Date().getDay()],
  end: { type: "never" },
});

function summary(r: Recurrence): string {
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  let s =
    r.interval > 1 ? `Every ${r.interval} ${UNIT[r.frequency]}s` : cap(r.frequency);
  if (r.frequency === "weekly" && r.weekdays.length) {
    s += " on " + [...r.weekdays].sort((a, b) => a - b).map((d) => WD[d]).join(", ");
  }
  if (r.end.type === "after") s += `, ${r.end.count}×`;
  else if (r.end.type === "on") s += `, until ${r.end.date}`;
  return s;
}

/** Task recurrence rule: a trigger showing the summary + a modal editor. */
export function RecurrenceField({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const current = value && typeof value === "object" ? (value as Recurrence) : null;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Recurrence>(current ?? defaultRecurrence());

  const openModal = () => {
    setDraft(current ?? defaultRecurrence());
    setOpen(true);
  };
  const set = (patch: Partial<Recurrence>) => setDraft((d) => ({ ...d, ...patch }));
  const toggleDay = (d: number) =>
    setDraft((cur) => ({
      ...cur,
      weekdays: cur.weekdays.includes(d)
        ? cur.weekdays.filter((x) => x !== d)
        : [...cur.weekdays, d],
    }));

  return (
    <div className="recur">
      <button type="button" className="dtp-trigger" onClick={openModal}>
        <Repeat size={15} />
        <span className={current ? "" : "dtp-placeholder"}>
          {current ? summary(current) : "No recurrence"}
        </span>
      </button>

      {open &&
        createPortal(
          <div className="modal-backdrop" onClick={() => setOpen(false)}>
            <div className="modal-card" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
              <h2 className="modal-title">Recurrence</h2>

              <label className="field">
                <span>Complete from</span>
                <select
                  value={draft.completeFrom}
                  onChange={(e) => set({ completeFrom: e.target.value as Recurrence["completeFrom"] })}
                >
                  <option value="scheduled">Scheduled date</option>
                  <option value="completed">Completed date</option>
                </select>
              </label>

              <label className="field">
                <span>Frequency</span>
                <select value={draft.frequency} onChange={(e) => set({ frequency: e.target.value as Freq })}>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="yearly">Yearly</option>
                </select>
              </label>

              <div className="field recur-every">
                <span>Every</span>
                <input
                  type="number"
                  min={1}
                  value={draft.interval}
                  onChange={(e) => set({ interval: Math.max(1, Number(e.target.value) || 1) })}
                />
                <span>{UNIT[draft.frequency]}{draft.interval > 1 ? "s" : ""}</span>
              </div>

              {draft.frequency === "weekly" && (
                <div className="field">
                  <span className="field-label">On days</span>
                  <div className="recur-days">
                    {WD.map((w, d) => (
                      <label key={w} className="recur-day">
                        <input
                          type="checkbox"
                          checked={draft.weekdays.includes(d)}
                          onChange={() => toggleDay(d)}
                          style={{ width: "auto" }}
                        />
                        <span>{w}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div className="field" style={{ borderTop: "1px solid var(--border)", paddingTop: 14 }}>
                <span className="field-label">End</span>
                <div className="recur-end">
                  <label className="recur-end-row">
                    <input
                      type="radio"
                      name="recur-end"
                      checked={draft.end.type === "never"}
                      onChange={() => set({ end: { type: "never" } })}
                      style={{ width: "auto" }}
                    />
                    <span>Never</span>
                  </label>
                  <label className="recur-end-row">
                    <input
                      type="radio"
                      name="recur-end"
                      checked={draft.end.type === "after"}
                      onChange={() => set({ end: { type: "after", count: 5 } })}
                      style={{ width: "auto" }}
                    />
                    <span>After</span>
                    <input
                      type="number"
                      min={1}
                      disabled={draft.end.type !== "after"}
                      value={draft.end.type === "after" ? draft.end.count : 5}
                      onChange={(e) => set({ end: { type: "after", count: Math.max(1, Number(e.target.value) || 1) } })}
                    />
                    <span>times</span>
                  </label>
                  <label className="recur-end-row">
                    <input
                      type="radio"
                      name="recur-end"
                      checked={draft.end.type === "on"}
                      onChange={() => set({ end: { type: "on", date: "" } })}
                      style={{ width: "auto" }}
                    />
                    <span>On</span>
                    {/* The app's own picker rather than the browser's: this was
                        the last native date input, and it looked and behaved
                        like nothing else here. */}
                    <DateTimePicker
                      value={draft.end.type === "on" ? draft.end.date : ""}
                      withTime={false}
                      placeholder="Pick a date"
                      onChange={(v) => set({ end: { type: "on", date: v } })}
                    />
                  </label>
                </div>
              </div>

              <div className="modal-actions">
                <button
                  className="ghost"
                  onClick={() => {
                    onChange(null);
                    setOpen(false);
                  }}
                >
                  Clear and Save
                </button>
                <button
                  className="primary"
                  onClick={() => {
                    onChange({ ...draft, n: current?.n });
                    setOpen(false);
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
