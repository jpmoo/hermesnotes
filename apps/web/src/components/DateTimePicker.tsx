import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * Date/Time picker: a month calendar (today highlighted) plus a 12-hour time
 * selector — typeable + stepper hour/minute boxes and an AM/PM pulldown.
 *
 * Value is a local wall-clock string "YYYY-MM-DDTHH:mm" (no timezone), the same
 * shape an <input type="datetime-local"> uses. Empty string means unset.
 */

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

interface Parts {
  date: string | null; // "YYYY-MM-DD"
  h: number; // 1..12
  m: number; // 0..59
  pm: boolean;
}

/** Parse "YYYY-MM-DDTHH:mm" (time optional) into 12-hour parts. */
function parse(value: string): Parts {
  const [datePart, timePart] = (value || "").split("T");
  const date = datePart && /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : null;
  let h24 = 0;
  let m = 0;
  if (timePart) {
    const [hh, mm] = timePart.split(":");
    h24 = Math.min(23, Math.max(0, Number(hh) || 0));
    m = Math.min(59, Math.max(0, Number(mm) || 0));
  }
  const pm = h24 >= 12;
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return { date, h, m, pm };
}

/** Combine parts back into "YYYY-MM-DDTHH:mm", or "" if no date is set. */
function combine(p: Parts): string {
  if (!p.date) return "";
  const h24 = p.pm ? (p.h === 12 ? 12 : p.h + 12) : p.h === 12 ? 0 : p.h;
  return `${p.date}T${pad(h24)}:${pad(p.m)}`;
}

/** "Jul 21, 2026, 3:42 PM" — friendly summary for the trigger button. */
function label(value: string): string {
  const p = parse(value);
  if (!p.date) return "";
  const [y, mo, d] = p.date.split("-").map(Number);
  const monthShort = MONTHS[(mo ?? 1) - 1]?.slice(0, 3) ?? "";
  return `${monthShort} ${d}, ${y}, ${p.h}:${pad(p.m)} ${p.pm ? "PM" : "AM"}`;
}

export function DateTimePicker({
  value,
  onChange,
  placeholder = "Set date & time",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const parts = parse(value);

  // The month shown in the calendar; seeded from the value or today.
  const seed = parts.date ? new Date(`${parts.date}T00:00`) : new Date();
  const [view, setView] = useState({ y: seed.getFullYear(), m: seed.getMonth() });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Merge a patch into the current parts and emit. Setting a day when no time
  // exists yet defaults to the current time so the value is immediately valid.
  const emit = (patch: Partial<Parts>) => {
    let base = parts;
    if (patch.date && !parts.date) {
      const now = new Date();
      const h24 = now.getHours();
      base = { ...parts, h: h24 % 12 === 0 ? 12 : h24 % 12, m: now.getMinutes(), pm: h24 >= 12 };
    }
    onChange(combine({ ...base, ...patch }));
  };

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
  const setHour = (h: number) => emit({ h: ((((h - 1) % 12) + 12) % 12) + 1 });
  const setMin = (m: number) => emit({ m: (((m % 60) + 60) % 60) });

  return (
    <div className="dtp" ref={wrapRef}>
      <button type="button" className="dtp-trigger" onClick={() => setOpen((o) => !o)}>
        <CalendarDays size={15} />
        <span className={value ? "" : "dtp-placeholder"}>{value ? label(value) : placeholder}</span>
        {value && (
          <span
            className="dtp-clear"
            title="Clear"
            role="button"
            onClick={(e) => {
              e.stopPropagation();
              onChange("");
            }}
          >
            <X size={13} />
          </span>
        )}
      </button>

      {open && (
        <div className="dtp-pop">
          <div className="dtp-cal-head">
            <button type="button" className="icon-btn" onClick={() => stepMonth(-1)} title="Previous month">
              <ChevronLeft size={16} />
            </button>
            <span className="dtp-month">{MONTHS[view.m]} {view.y}</span>
            <button type="button" className="icon-btn" onClick={() => stepMonth(1)} title="Next month">
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
                type="button"
                key={c.key}
                className={
                  "dtp-day" +
                  (c.inMonth ? "" : " out") +
                  (c.key === parts.date ? " sel" : "") +
                  (c.key === today ? " today" : "")
                }
                onClick={() => {
                  if (!c.inMonth) {
                    const d = new Date(`${c.key}T00:00`);
                    setView({ y: d.getFullYear(), m: d.getMonth() });
                  }
                  emit({ date: c.key });
                }}
              >
                {c.day}
              </button>
            ))}
          </div>

          <div className="dtp-time">
            <div className="dtp-spin">
              <button type="button" className="icon-btn" onClick={() => setHour(parts.h + 1)}>
                <ChevronUp size={14} />
              </button>
              <input
                className="dtp-num"
                inputMode="numeric"
                value={parts.h}
                onChange={(e) => {
                  const n = Number(e.target.value.replace(/\D/g, ""));
                  if (n >= 1 && n <= 12) setHour(n);
                }}
              />
              <button type="button" className="icon-btn" onClick={() => setHour(parts.h - 1)}>
                <ChevronDown size={14} />
              </button>
            </div>
            <span className="dtp-colon">:</span>
            <div className="dtp-spin">
              <button type="button" className="icon-btn" onClick={() => setMin(parts.m + 1)}>
                <ChevronUp size={14} />
              </button>
              <input
                className="dtp-num"
                inputMode="numeric"
                value={pad(parts.m)}
                onChange={(e) => {
                  const n = Number(e.target.value.replace(/\D/g, ""));
                  if (n >= 0 && n <= 59) setMin(n);
                }}
              />
              <button type="button" className="icon-btn" onClick={() => setMin(parts.m - 1)}>
                <ChevronDown size={14} />
              </button>
            </div>
            <select
              className="dtp-ampm"
              value={parts.pm ? "PM" : "AM"}
              onChange={(e) => emit({ pm: e.target.value === "PM" })}
            >
              <option value="AM">AM</option>
              <option value="PM">PM</option>
            </select>
          </div>

          <div className="dtp-actions">
            <button
              type="button"
              className="ghost"
              onClick={() => {
                const now = new Date();
                setView({ y: now.getFullYear(), m: now.getMonth() });
                const h24 = now.getHours();
                onChange(
                  combine({
                    date: ymd(now),
                    h: h24 % 12 === 0 ? 12 : h24 % 12,
                    m: now.getMinutes(),
                    pm: h24 >= 12,
                  }),
                );
              }}
            >
              Now
            </button>
            <button type="button" className="ghost" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
