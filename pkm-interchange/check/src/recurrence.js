import {
  WEEKDAYS,
  addDays,
  addMonths,
  dayOfMonth,
  daysInMonth,
  formatDay,
  parseDay,
  weekdayOf,
} from "./dates.js";

/**
 * The next occurrence of a series, or null when the series is over.
 *
 * The two anchors are different computations, not two settings on one. A
 * schedule-anchored rule advances from where the last occurrence *was due*; a
 * completion-anchored one advances from when it was actually finished, which is
 * why it can only ever know one occurrence ahead.
 *
 * A clamped monthly rule must not re-anchor: it is still "the 31st" after a
 * February that had to settle for the 28th. `rule.byMonthDay` is where that
 * lives; `anchorDay` is the fallback for a rule that predates it.
 */
export function nextOccurrence({ rule, instances = [], anchorDay }, instance, event = {}) {
  const end = rule.end ?? { type: "never" };

  // "After N times" is counted from the instances that exist, not from a
  // counter carried on the rule. A count living on the rule is instance state
  // in a rule object, and every copy of the rule then has to nurse it.
  if (end.type === "after" && instances.length >= end.count) return null;

  const due = parseDay(instance?.due);
  const start = parseDay(instance?.start);
  const completed = parseDay(event.completed);
  const base = rule.anchor === "completion" ? completed ?? due : due;
  if (base === null || base === undefined) return null;

  // The rule says which day it is anchored to. Falling back to an instance is a
  // guess, and a bad one on a series that has already been clamped — the
  // instance says the 28th and the rule meant the 31st.
  const anchor =
    rule.byMonthDay ?? anchorDay ?? (due !== null ? dayOfMonth(due) : dayOfMonth(base));
  const nextDue = advance(base, rule, anchor);
  if (nextDue === null) return null;

  if (end.type === "on") {
    const limit = parseDay(end.date);
    // The boundary is inclusive: a rule that ends "on the 2nd" includes the 2nd.
    if (limit !== null && nextDue > limit) return null;
  }

  const out = { due: formatDay(nextDue) };
  if (start !== null && due !== null) {
    // Schedule-anchored moves the whole span by however far the due date moved.
    // Completion-anchored keeps the gap between the two ends, because the span
    // is "how long you get", and it starts again from the new due date.
    const shifted = rule.anchor === "completion" ? nextDue - (due - start) : start + (nextDue - due);
    out.start = formatDay(shifted);
  }
  return out;
}

function advance(base, rule, anchorDay) {
  const interval = Math.max(1, rule.interval ?? 1);
  switch (rule.freq) {
    case "daily":
      return addDays(base, interval);

    case "weekly": {
      const days = (rule.byWeekday ?? []).map((w) => WEEKDAYS.indexOf(w)).filter((i) => i >= 0);
      if (!days.length) return addDays(base, 7 * interval);
      // Walk forward to the next named weekday that also lands on an interval
      // week. Two-weekly on a Wednesday means every other Wednesday, not the
      // next one.
      for (let i = 1; i <= 7 * interval + 7; i++) {
        const c = addDays(base, i);
        if (days.includes(weekdayOf(c)) && Math.floor(i / 7) % interval === 0) return c;
      }
      return addDays(base, 7 * interval);
    }

    case "monthly":
    case "yearly": {
      const step = rule.freq === "yearly" ? 12 * interval : interval;
      const clamp = rule.monthEnd === "clamp";
      // Skip may have to pass over several months — a rule on the 31st meets
      // four of them in a year.
      for (let n = 1; n <= 60; n++) {
        const { year, month } = addMonths(base, step * n);
        const room = daysInMonth(year, month);
        if (anchorDay <= room) return Date.UTC(year, month, anchorDay);
        if (clamp) return Date.UTC(year, month, room);
        // skip: this month cannot hold the anchor day, so it isn't an occurrence.
      }
      return null;
    }

    default:
      return null;
  }
}
