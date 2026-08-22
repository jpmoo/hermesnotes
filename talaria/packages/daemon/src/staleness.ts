/**
 * How much the mirror can be trusted right now.
 *
 * The honest answer differs by what's being asked — a task list a few hours old
 * is useful, a calendar a few hours old may not be — but a proof of concept
 * gets one policy, and the important part is that it is *stated* rather than
 * hidden. A surface that quietly serves week-old data is how trust in the whole
 * layer goes.
 */
export type Freshness = "never" | "fresh" | "stale" | "cold";

const FRESH_MS = 5 * 60 * 1000;
const COLD_MS = 24 * 60 * 60 * 1000;

export function freshnessOf(lastSuccessAt: string | null, everSynced: boolean, now = Date.now()): Freshness {
  // Distinct from "cold": there is nothing here at all, which is a different
  // thing to tell someone than "this might be out of date".
  if (!everSynced || !lastSuccessAt) return "never";
  const age = now - Date.parse(lastSuccessAt);
  if (!Number.isFinite(age)) return "never";
  if (age < FRESH_MS) return "fresh";
  if (age < COLD_MS) return "stale";
  return "cold";
}

export function describe(f: Freshness, lastSuccessAt: string | null): string {
  switch (f) {
    case "never":
      return "never synced — the mirror is empty until Hermes can be reached";
    case "fresh":
      return "up to date";
    case "stale":
      return `as of ${lastSuccessAt ? new Date(lastSuccessAt).toLocaleString() : "unknown"}`;
    case "cold":
      return `last reached ${lastSuccessAt ? new Date(lastSuccessAt).toLocaleString() : "never"} — more than a day ago`;
  }
}
