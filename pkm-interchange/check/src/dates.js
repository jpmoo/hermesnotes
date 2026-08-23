/**
 * Calendar arithmetic on `YYYY-MM-DD`, done in UTC.
 *
 * Local-time arithmetic is how recurrence engines acquire off-by-one-day bugs
 * that only appear for readers in some time zones and only in some months. A
 * date here is a date, not an instant.
 */

const DAY = 86400000;

export function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s ?? ""));
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function formatDay(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

export const addDays = (t, n) => t + n * DAY;
export const daysBetween = (a, b) => Math.round((b - a) / DAY);
export const weekdayOf = (t) => new Date(t).getUTCDay();
export const dayOfMonth = (t) => new Date(t).getUTCDate();

export function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** Month `n` after `t`, keeping the year straight. */
export function addMonths(t, n) {
  const d = new Date(t);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + n };
}

export const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
