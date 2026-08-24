import { recurrenceSchema } from "@hermes/shared";
import type { CanonicalRecurrence } from "./types.js";

/**
 * A stable identity for the series a recurring block belongs to.
 *
 * Hermes has no such thing: completing an occurrence spawns the next as an
 * ordinary independent block, and nothing links the two. `n` counts occurrences
 * precisely because there is no relationship to count them by.
 *
 * Hermes stamps a real one now and the mirror carries it, so this is the
 * fallback rather than the answer: derived from the things that don't change
 * between occurrences — the type, the title, and the rule itself — which is
 * stable for a series nobody edits and wrong the moment a title changes. It
 * still runs for blocks written before Hermes had series, and for anything that
 * has not passed through a completion since.
 */
function seriesIdFor(typeId: string | null, title: string, rule: unknown): string {
  const basis = JSON.stringify([typeId, title.trim().toLowerCase(), rule]);
  // FNV-1a: short, stable, and no crypto import for something that is a label
  // rather than a secret.
  let h = 0x811c9dc5;
  for (let i = 0; i < basis.length; i++) {
    h ^= basis.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `series-${h.toString(16).padStart(8, "0")}`;
}

/** A Hermes recurrence value as the canonical form, or null if it isn't one. */
export function toCanonicalRecurrence(
  value: unknown,
  ctx: { typeId: string | null; title: string; seriesId?: string | null },
): CanonicalRecurrence | null {
  const parsed = recurrenceSchema.safeParse(value);
  if (!parsed.success) return null;
  const rec = parsed.data;
  const anchor = rec.completeFrom === "completed" ? "completion" : "schedule";
  return {
    // Hermes' own, when it has one. Guessing is for blocks written before it did.
    seriesId: ctx.seriesId ?? seriesIdFor(ctx.typeId, ctx.title, {
      f: rec.frequency,
      i: rec.interval,
      w: rec.weekdays,
      c: rec.completeFrom,
    }),
    anchor,
    frequency: rec.frequency,
    interval: rec.interval,
    weekdays: rec.weekdays,
    end:
      rec.end.type === "after"
        ? { kind: "after", count: rec.end.count }
        : rec.end.type === "on"
          ? { kind: "on", date: rec.end.date }
          : { kind: "never" },
    // Null on anything written since Hermes stopped counting occurrences on the
    // rule. The number lives with the series now, which this mirror does not
    // carry — so the honest answer here is "not known" rather than a stale one.
    occurrence: rec.n ?? null,
    expressibleAsRRULE: anchor === "schedule",
  };
}
