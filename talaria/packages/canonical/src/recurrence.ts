import type { CanonicalRecurrence } from "./types.js";

/**
 * Recurrence, read off the series the producer declared.
 *
 * This module used to be a small act of invention. Hermes kept a rule on each
 * block and nothing tied occurrences together, so the seam hashed the type, the
 * title and the rule into a synthetic identity — stable for a series nobody
 * edited, wrong the moment a title changed, and the only thing available.
 *
 * The format holds recurrence as a **series** with its instances pointing at it,
 * so there is nothing left to guess: the id is the producer's, the membership is
 * the producer's, and a renamed occurrence stays in the series it was always in.
 * The whole hash is gone.
 */

const WEEKDAY_INDEX: Record<string, number> = {
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
};

/**
 * The frequencies this seam knows. A producer may say something else — the
 * format does not close the list — and a rule we cannot name is better read as
 * weekly than dropped, since the alternative is a recurring task that arrives
 * looking like it never repeats.
 */
const FREQ = ["daily", "weekly", "monthly", "yearly"] as const;
type Freq = (typeof FREQ)[number];

export interface SeriesRule {
  anchor?: string;
  freq?: string;
  interval?: number;
  byWeekday?: string[];
  byMonthDay?: number;
  monthEnd?: string;
  end?: { type?: string; count?: number; date?: string };
}

export interface Series {
  id: string;
  rule?: SeriesRule;
  horizon?: number;
  instances?: string[];
}

/** A declared series as the canonical form, or null when there isn't one. */
export function toCanonicalRecurrence(series: Series | null | undefined): CanonicalRecurrence | null {
  const rule = series?.rule;
  if (!series || !rule?.freq) return null;

  // The format's own word. `completion` means the next occurrence is unknowable
  // until this one is ticked, which is why only such a rule caps its horizon.
  const anchor = rule.anchor === "completion" ? "completion" : "schedule";
  const end = rule.end ?? { type: "never" };

  return {
    seriesId: series.id,
    anchor,
    frequency: FREQ.includes(rule.freq as Freq) ? (rule.freq as Freq) : "weekly",
    interval: typeof rule.interval === "number" ? rule.interval : 1,
    // Back to indices, which is what everything downstream of the seam counts in.
    weekdays: (rule.byWeekday ?? [])
      .map((d) => WEEKDAY_INDEX[d])
      .filter((n): n is number => n !== undefined),
    end:
      end.type === "after" && typeof end.count === "number"
        ? { kind: "after", count: end.count }
        : end.type === "on" && typeof end.date === "string"
          ? { kind: "on", date: end.date }
          : { kind: "never" },
    // How many have happened is a fact about the series, and the format does not
    // carry a count. `instances` is what this export happened to include, which
    // is not the same number and must not be passed off as one.
    occurrence: null,
    expressibleAsRRULE: anchor === "schedule",
  };
}

/** Which series each object belongs to, from the envelope's own membership lists. */
export function seriesByObject(all: Series[] | undefined): Map<string, Series> {
  const index = new Map<string, Series>();
  for (const s of all ?? []) for (const id of s.instances ?? []) index.set(id, s);
  return index;
}
