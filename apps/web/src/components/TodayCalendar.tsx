import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api.ts";

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * Month calendar for the Today page. Dots mark dates with a (non-empty)
 * scratchpad note; clicking a day navigates to that day's Today sheet.
 */
export function TodayCalendar({ selected }: { selected: string }) {
  const nav = useNavigate();
  const [dates, setDates] = useState<Set<string>>(new Set());
  const seed = new Date(`${selected}T00:00`);
  const [view, setView] = useState({ y: seed.getFullYear(), m: seed.getMonth() });

  // Refetch when the selected date changes — its note may have gained content.
  useEffect(() => {
    void api.get<string[]>("/today/dates").then((ds) => setDates(new Set(ds)));
  }, [selected]);

  const today = ymd(new Date());
  const first = new Date(view.y, view.m, 1);
  const gridStart = new Date(view.y, view.m, 1 - first.getDay());
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    return { key: ymd(d), day: d.getDate(), inMonth: d.getMonth() === view.m };
  });
  const stepMonth = (dir: -1 | 1) => {
    const d = new Date(view.y, view.m + dir, 1);
    setView({ y: d.getFullYear(), m: d.getMonth() });
  };

  return (
    <div className="today-cal">
      <div className="dtp-cal-head">
        <button className="icon-btn" onClick={() => stepMonth(-1)} title="Previous month">
          <ChevronLeft size={16} />
        </button>
        <span className="dtp-month">{MONTHS[view.m]} {view.y}</span>
        <button className="icon-btn" onClick={() => stepMonth(1)} title="Next month">
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="dtp-grid dtp-dow">
        {WEEKDAYS.map((w) => (
          <span key={w} className="dtp-dow-cell">{w}</span>
        ))}
      </div>
      <div className="dtp-grid">
        {cells.map((c) => (
          <button
            key={c.key}
            className={
              "dtp-day" +
              (c.inMonth ? "" : " out") +
              (c.key === selected ? " sel" : "") +
              (c.key === today ? " today" : "") +
              (dates.has(c.key) ? " has-note" : "")
            }
            onClick={() => nav(`/today/${c.key}`)}
          >
            {c.day}
          </button>
        ))}
      </div>
    </div>
  );
}
