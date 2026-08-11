import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Date/Time picker: a month calendar (today highlighted) plus a 12-hour time
 * selector — typeable + stepper hour/minute boxes and an AM/PM pulldown.
 *
 * Value is a local wall-clock string "YYYY-MM-DDTHH:mm" (no timezone), the same
 * shape an <input type="datetime-local"> uses — or a bare "YYYY-MM-DD" when no
 * time is set (the default; time is opt-in). Empty string means unset.
 */

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const DOW_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

interface Parts {
  date: string | null; // "YYYY-MM-DD"
  hasTime: boolean; // false => the value is date-only
  h: number; // 1..12
  m: number; // 0..59
  pm: boolean;
}

/** Parse "YYYY-MM-DDTHH:mm" or "YYYY-MM-DD" into 12-hour parts. */
function parse(value: string): Parts {
  const [datePart, timePart] = (value || "").split("T");
  const date = datePart && /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : null;
  let h24 = 12; // noon base for the first time interaction
  let m = 0;
  if (timePart) {
    const [hh, mm] = timePart.split(":");
    h24 = Math.min(23, Math.max(0, Number(hh) || 0));
    m = Math.min(59, Math.max(0, Number(mm) || 0));
  }
  const pm = h24 >= 12;
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return { date, hasTime: Boolean(timePart), h, m, pm };
}

/** Combine parts back into "YYYY-MM-DD[THH:mm]", or "" if no date is set. */
function combine(p: Parts): string {
  if (!p.date) return "";
  if (!p.hasTime) return p.date;
  const h24 = p.pm ? (p.h === 12 ? 12 : p.h + 12) : p.h === 12 ? 0 : p.h;
  return `${p.date}T${pad(h24)}:${pad(p.m)}`;
}

/** "Jul 21, 2026, 3:42 PM" (or date only) — summary for the trigger button. */
function label(value: string): string {
  const p = parse(value);
  if (!p.date) return "";
  const [y, mo, d] = p.date.split("-").map(Number);
  const monthShort = MONTHS[(mo ?? 1) - 1]?.slice(0, 3) ?? "";
  const day = `${monthShort} ${d}, ${y}`;
  return p.hasTime ? `${day}, ${p.h}:${pad(p.m)} ${p.pm ? "PM" : "AM"}` : day;
}

export function DateTimePicker({
  value,
  onChange,
  placeholder,
  withTime = true,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /**
   * Whether this value can carry a time at all. A field declared as a date has
   * no business offering hours and minutes — picking one would quietly turn it
   * into a datetime — and with no time to set, choosing the day is the whole
   * job, so the popup closes on it. That's also why closing on a day pick felt
   * wrong before: it isn't wrong here, it was wrong where a time still followed.
   */
  withTime?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [dowOpen, setDowOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const parts = parse(value);
  const hint = placeholder ?? (withTime ? "Set date & time" : "Set date");
  /**
   * A date-only field still shows the time controls if the value it's holding
   * already has one — a field whose type was changed from datetime to date, or
   * anything written before that distinction was made. The rule is "don't offer
   * to add a time here", not "make an existing one unreachable": hiding the
   * controls over a value that has a time would leave it uneditable and
   * unclearable, which is worse than the inconsistency it was tidying up.
   */
  const showTime = withTime || parts.hasTime;

  // The popup is position:fixed so scroll containers (table view, right
  // panel) can't clip it — measured from the trigger, flipped when the
  // viewport bottom is too close, tracking scroll/resize.
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const r = wrapRef.current?.getBoundingClientRect();
      if (!r) return;
      const H = 440; // approximate popup height
      const below = window.innerHeight - r.bottom;
      setPos({
        left: Math.max(8, Math.min(r.left, window.innerWidth - 284)),
        top: below < H && r.top > below ? Math.max(8, r.top - H - 4) : r.bottom + 4,
      });
    };
    measure();
    window.addEventListener("resize", measure);
    document.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      document.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  // The month shown in the calendar; seeded from the value or today.
  const seed = parts.date ? new Date(`${parts.date}T00:00`) : new Date();
  const [view, setView] = useState({ y: seed.getFullYear(), m: seed.getMonth() });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      // The popup lives at the end of the body now, so "inside the trigger"
      // isn't the whole story — a click in the calendar has to count as inside.
      if (wrapRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Merge a patch into the current parts and emit. Picking a day leaves the
  // time blank (date-only value); touching any time control opts into a time.
  const emit = (patch: Partial<Parts>) => {
    const touchesTime = patch.h !== undefined || patch.m !== undefined || patch.pm !== undefined;
    const hasTime = patch.hasTime !== undefined ? patch.hasTime : parts.hasTime || touchesTime;
    onChange(combine({ ...parts, ...patch, hasTime }));
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

  /** Jump to a day, keeping any time already set, and show its month. */
  const goTo = (d: Date) => {
    setView({ y: d.getFullYear(), m: d.getMonth() });
    emit({ date: ymd(d) });
  };
  // +1 day / +1 week: relative to the entered date, or today when unset.
  const addDays = (days: number) => {
    const d = parts.date ? new Date(`${parts.date}T00:00`) : new Date();
    d.setDate(d.getDate() + days);
    goTo(d);
  };
  // Next occurrence of a weekday, strictly after today (Tue → next Tuesday).
  const nextDow = (target: number) => {
    const now = new Date();
    const ahead = ((target - now.getDay() + 6) % 7) + 1;
    goTo(new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead));
    setDowOpen(false);
  };

  return (
    <div className="dtp" ref={wrapRef}>
      <button type="button" className="dtp-trigger" onClick={() => setOpen((o) => !o)}>
        <CalendarDays size={15} />
        <span className={value ? "" : "dtp-placeholder"}>{value ? label(value) : hint}</span>
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

      {/* Out to the body: "fixed" is measured against the nearest transformed
          ancestor, not the window, and a canvas node lives inside a layer that
          pans and zooms by transform — so a popup positioned at window
          coordinates landed a screen away from the field that opened it, at the
          wrong scale. Nothing else needs to know; the coordinates are already
          the right ones. */}
      {open &&
        pos &&
        createPortal(
          <div
            className="dtp-pop"
            ref={popRef}
            style={{ position: "fixed", left: pos.left, top: pos.top }}
          >
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
                // Stays open on a day: the time controls are below it, and a
                // date and a time are usually chosen in one visit. Done (or a
                // click outside) closes it.
                onClick={() => {
                  if (!c.inMonth) {
                    const d = new Date(`${c.key}T00:00`);
                    setView({ y: d.getFullYear(), m: d.getMonth() });
                  }
                  emit({ date: c.key });
                  // Nothing else to choose here — unless this value carries a
                  // time that's still editable below.
                  if (!showTime) setOpen(false);
                }}
              >
                {c.day}
              </button>
            ))}
          </div>

          {showTime && <div className="dtp-time">
            <div className="dtp-spin">
              <button type="button" className="icon-btn" onClick={() => setHour(parts.h + 1)}>
                <ChevronUp size={14} />
              </button>
              <input
                className="dtp-num"
                inputMode="numeric"
                placeholder="--"
                value={parts.hasTime ? parts.h : ""}
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
                placeholder="--"
                value={parts.hasTime ? pad(parts.m) : ""}
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
          </div>}

          <div className="dtp-quick">
            <button type="button" className="ghost" onClick={() => addDays(1)}>
              +1 day
            </button>
            <button type="button" className="ghost" onClick={() => addDays(7)}>
              +1 week
            </button>
            <span className="nav-kebab" style={{ position: "relative" }}>
              <button type="button" className="ghost" onClick={() => setDowOpen((o) => !o)}>
                Weekday <ChevronDown size={12} />
              </button>
              {dowOpen && (
                <div className="menu" style={{ left: 0, right: "auto", top: "auto", bottom: "calc(100% + 4px)" }}>
                  {DOW_FULL.map((name, i) => (
                    <button type="button" key={name} className="menu-item" onClick={() => nextDow(i)}>
                      {name}
                    </button>
                  ))}
                </div>
              )}
            </span>
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
                  withTime
                    ? combine({
                        date: ymd(now),
                        hasTime: true,
                        h: h24 % 12 === 0 ? 12 : h24 % 12,
                        m: now.getMinutes(),
                        pm: h24 >= 12,
                      })
                    : ymd(now),
                );
                setOpen(false); // nothing left to choose either way
              }}
            >
              {withTime ? "Now" : "Today"}
            </button>
            {showTime && parts.hasTime && parts.date && (
              <button type="button" className="ghost" onClick={() => emit({ hasTime: false })}>
                Clear time
              </button>
            )}
            <button type="button" className="ghost" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
