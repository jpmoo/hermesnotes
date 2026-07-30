/**
 * Periodic notes — the family that daily scratchpads and weekly reflections
 * belong to.
 *
 * What makes one of these different from an ordinary note is not its content but
 * its provenance: it belongs to a span of time rather than being filed by hand.
 * That single fact is what drives all the behaviour they share:
 *
 * - created on demand, by opening the day or the review, not by a "new" action;
 * - identified by the period they belong to (a date in `properties[marker]`),
 *   never by title, so the page that owns one can always find it again;
 * - hidden from normal block listings — they'd otherwise swamp them;
 * - swept when empty, since merely browsing brings them into being;
 * - not archivable, because the owning page resolves them by marker regardless
 *   and would keep rendering one that was supposedly filed away.
 *
 * Adding a kind — a monthly review, say — is an entry here plus the page that
 * owns it. The behaviours above then apply without hunting for the places that
 * check for a marker.
 *
 * Two spots still encode per-kind behaviour on purpose, because it genuinely
 * differs rather than being shared:
 * - collections/query.ts, where daily notes can be opted BACK IN via the Daily
 *   Note sentinel type while reflections are always hidden;
 * - export/routes.ts, which files each kind under its own folder name.
 */

export interface PeriodicNoteKind {
  /** The `properties` key whose value is the period this note belongs to. */
  marker: string;
  /** Reader-facing name for one of these, singular. */
  label: string;
  /** How to name a specific instance, given the period from `marker`. */
  describe: (period: string) => string;
}

export const PERIODIC_NOTE_KINDS: readonly PeriodicNoteKind[] = [
  {
    marker: "today_note",
    label: "daily note",
    describe: (period) => `Daily note · ${period}`,
  },
  {
    marker: "review_reflection",
    label: "weekly reflection",
    describe: (period) => `Weekly review · week ending ${period}`,
  },
];

/** Just the property keys — for building SQL, or checking a bag of properties. */
export const PERIODIC_MARKERS: readonly string[] = PERIODIC_NOTE_KINDS.map((k) => k.marker);

/**
 * Which kind of periodic note this is, and the period it belongs to — or null
 * for an ordinary note.
 */
export function periodicKindOf(
  properties: unknown,
): { kind: PeriodicNoteKind; period: string } | null {
  const props = (properties ?? {}) as Record<string, unknown>;
  for (const kind of PERIODIC_NOTE_KINDS) {
    const period = props[kind.marker];
    if (typeof period === "string" && period) return { kind, period };
  }
  return null;
}

/** Whether this note belongs to a period rather than being filed by hand. */
export function isPeriodicNote(properties: unknown): boolean {
  return periodicKindOf(properties) !== null;
}
