import { z } from "zod";

/** A recurrence rule (task-only). Edited in a modal; see the design screenshot. */
export const recurrenceSchema = z.object({
  /** advance the next occurrence from the scheduled dates or from the completion date */
  completeFrom: z.enum(["scheduled", "completed"]).default("scheduled"),
  frequency: z.enum(["daily", "weekly", "monthly", "yearly"]).default("weekly"),
  interval: z.number().int().min(1).default(1),
  /** for weekly: which weekdays recur (0=Sun … 6=Sat) */
  weekdays: z.array(z.number().int().min(0).max(6)).default([]),
  /**
   * monthly/yearly: which day of the month the rule is anchored to.
   *
   * Without it the day has to be read off the current occurrence, and once a
   * short month has clamped one, the occurrence says the 28th while the rule
   * meant the 31st — so the series moves to the 28th permanently. Absent on
   * every rule written before this existed; stamped from the current due date
   * the next time one is advanced, which stops the drift where it stands
   * without pretending to undo what already happened.
   */
  monthDay: z.number().int().min(1).max(31).optional(),
  /**
   * monthly/yearly: what to do in a month too short for the anchor day.
   *
   * "clamp" gives 28 February for a rule on the 31st; "skip" leaves February out
   * and goes to 31 March, which is what RRULE and EventKit do. Neither is wrong.
   * Defaulted to clamp because that is what Hermes has always done, and a
   * default that silently changed every existing month-end task would be a worse
   * bug than the one being fixed.
   */
  monthEnd: z.enum(["skip", "clamp"]).default("clamp"),
  end: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("never") }),
      z.object({ type: z.literal("after"), count: z.number().int().min(1) }),
      z.object({ type: z.literal("on"), date: z.string() }),
    ])
    .default({ type: "never" }),
  /** 1-based occurrence index of this task within the series (for "after N times") */
  n: z.number().int().min(1).optional(),
});
export type Recurrence = z.infer<typeof recurrenceSchema>;

const pad = (n: number) => String(n).padStart(2, "0");

/** Split "YYYY-MM-DD[THH:mm]" into a local Date (date part) + the time suffix. */
function parse(value: string): { date: Date; time: string } | null {
  const [d, t] = value.split("T");
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const [y, m, day] = d.split("-").map(Number);
  return { date: new Date(y!, m! - 1, day!), time: t ? `T${t}` : "" };
}
const fmt = (dt: Date, time: string) =>
  `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}${time}`;

/**
 * The next occurrence date strictly after `anchor` (a Date), per the rule.
 * Weekly with selected weekdays returns the next matching weekday; interval>1
 * weeks are approximated by requiring the week offset to be a multiple.
 */
export function nextAfter(anchor: Date, rec: Recurrence): Date {
  const iv = Math.max(1, rec.interval);
  if (rec.frequency === "daily") {
    return new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + iv);
  }
  if (rec.frequency === "weekly") {
    const days = rec.weekdays.length ? rec.weekdays : [anchor.getDay()];
    for (let i = 1; i <= 7 * iv + 7; i++) {
      const c = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + i);
      const weekOffset = Math.floor(i / 7);
      if (days.includes(c.getDay()) && (iv === 1 || weekOffset % iv === 0)) return c;
    }
    return new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + 7 * iv);
  }
  // Monthly and yearly are the same walk at different strides. The day comes
  // from the rule where the rule says so — advancing from the last occurrence's
  // day is what turns one clamped February into a series on the 28th forever.
  const step = rec.frequency === "yearly" ? 12 * iv : iv;
  const wanted = rec.monthDay ?? anchor.getDate();
  for (let n = 1; n <= 60; n++) {
    const probe = new Date(anchor.getFullYear(), anchor.getMonth() + step * n, 1);
    const room = daysInMonth(probe.getFullYear(), probe.getMonth());
    if (wanted <= room) return new Date(probe.getFullYear(), probe.getMonth(), wanted);
    if (rec.monthEnd !== "skip") return new Date(probe.getFullYear(), probe.getMonth(), room);
    // skip: this month cannot hold the day, so it is not an occurrence at all.
  }
  return new Date(anchor.getFullYear(), anchor.getMonth() + step, 1);
}

function daysInMonth(y: number, m: number): number {
  return new Date(y, m + 1, 0).getDate();
}

const dayMs = 24 * 60 * 60 * 1000;

/**
 * Given the current schedule span {start=available, end=due} and the recurrence,
 * compute the next span. `completedOn` is the local date (yyyy-mm-dd) the task
 * was completed. Returns null if there's no date to advance from.
 */
export function nextSpan(
  span: { start?: string; end?: string } | undefined,
  rec: Recurrence,
  completedOn: string,
): { start?: string; end?: string } | null {
  const dueRaw = span?.end || span?.start;
  if (!dueRaw) return null;
  const due = parse(dueRaw);
  if (!due) return null;
  const avail = span?.start ? parse(span.start) : null;

  let nextDueDate: Date;
  let stepMs: number;
  if (rec.completeFrom === "completed") {
    const comp = parse(completedOn);
    const anchor = comp ? comp.date : new Date();
    nextDueDate = nextAfter(anchor, rec);
    // Preserve the available→due gap, anchored to the new due.
    const gapMs = avail ? due.date.getTime() - avail.date.getTime() : 0;
    stepMs = 0; // available derived from gap below
    const nextEnd = fmt(nextDueDate, due.time);
    const startOut =
      avail !== null
        ? fmt(new Date(nextDueDate.getTime() - gapMs), avail.time)
        : undefined;
    return { ...(startOut ? { start: startOut } : {}), end: nextEnd };
  }
  // scheduled: shift the whole span by the due date's advance.
  nextDueDate = nextAfter(due.date, rec);
  stepMs = nextDueDate.getTime() - due.date.getTime();
  const end = fmt(nextDueDate, due.time);
  const start = avail ? fmt(new Date(avail.date.getTime() + stepMs), avail.time) : undefined;
  return { ...(start ? { start } : {}), end };
}

/** Whether the series has more occurrences after the one indexed `currentN`. */
export function recurrenceContinues(rec: Recurrence, currentN: number, nextDue: string): boolean {
  if (rec.end.type === "after") return currentN < rec.end.count;
  if (rec.end.type === "on") {
    const nd = nextDue.split("T")[0];
    return !!nd && nd <= rec.end.date;
  }
  return true; // never
}

/** One-line human summary, e.g. "Weekly on Wed · ends after 5". */
export function recurrenceSummary(rec: Recurrence): string {
  const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const every = rec.interval > 1 ? `every ${rec.interval} ` : "";
  let base: string;
  if (rec.frequency === "daily") base = `${every}day${rec.interval > 1 ? "s" : "ly"}`;
  else if (rec.frequency === "weekly") {
    const on = rec.weekdays.length
      ? " on " + [...rec.weekdays].sort((a, b) => a - b).map((d) => WD[d]).join(", ")
      : "";
    base = `${every}week${rec.interval > 1 ? "s" : "ly"}${on}`;
  } else if (rec.frequency === "monthly") base = `${every}month${rec.interval > 1 ? "s" : "ly"}`;
  else base = `${every}year${rec.interval > 1 ? "s" : "ly"}`;
  const end =
    rec.end.type === "after"
      ? `, ends after ${rec.end.count}`
      : rec.end.type === "on"
        ? `, until ${rec.end.date}`
        : "";
  return base.charAt(0).toUpperCase() + base.slice(1) + end;
}
