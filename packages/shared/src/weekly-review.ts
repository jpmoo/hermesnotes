import { z } from "zod";

/**
 * Weekly review: a guided, ordered set of "steps" the user marches through once
 * a week, driven by a recurring "Do weekly review" task. The whole config lives
 * in `user_settings.preferences` under {@link WEEKLY_REVIEW_PREF_KEY} — a global
 * template (steps that recur every week) plus a per-cycle slice (this-week-only
 * steps + which steps are checked done) that resets when a new review opens.
 */

/** A step's link target — a block or collection. Null = an "outside" step the
 *  user handles outside Hermes Notes and just checks off. */
export const reviewLinkSchema = z.object({
  t: z.enum(["block", "collection"]),
  id: z.string().uuid(),
});
export type ReviewLink = z.infer<typeof reviewLinkSchema>;

export const reviewStepSchema = z.object({
  /** Stable id (uuid) — identity for drag-reorder and done-tracking. */
  id: z.string().min(1),
  description: z.string().default(""),
  link: reviewLinkSchema.nullable().default(null),
});
export type ReviewStep = z.infer<typeof reviewStepSchema>;

export const MAX_REVIEW_STEPS = 100;

/** Per-cycle state — cleared each time a new review becomes available. */
export const reviewCycleSchema = z.object({
  /** The current cycle's available date (or due date if there's no available
   *  offset); when the live task's date passes this, the cycle resets. */
  key: z.string().default(""),
  /** Steps added "for this review only". */
  extras: z.array(reviewStepSchema).max(MAX_REVIEW_STEPS).default([]),
  /** Step ids checked done this cycle. */
  done: z.array(z.string()).default([]),
  /** The full step-id order for this cycle (template + extras interleaved). */
  order: z.array(z.string()).max(MAX_REVIEW_STEPS * 2).default([]),
});
export type ReviewCycle = z.infer<typeof reviewCycleSchema>;

export const weeklyReviewSchema = z.object({
  /** 0=Sun … 6=Sat — the review task's DUE weekday. Null = not configured
   *  (no rail icon, no managed task). */
  dueWeekday: z.number().int().min(0).max(6).nullable().default(null),
  /** Days before the due date the task becomes available: 0 = no available
   *  date, 1..6 = available that many days early. */
  availableDaysPrior: z.number().int().min(0).max(6).default(0),
  /** The template — steps present in every review; reorder saves here. */
  steps: z.array(reviewStepSchema).max(MAX_REVIEW_STEPS).default([]),
  cycle: reviewCycleSchema.default({ key: "", extras: [], done: [], order: [] }),
  /** Project(s) the managed "Do weekly review" task is filed under — block ids
   *  for the task type's project reference field (empty = none). */
  project: z.array(z.string()).default([]),
});
export type WeeklyReview = z.infer<typeof weeklyReviewSchema>;

/** Key under `user_settings.preferences` where the whole config is stored. */
export const WEEKLY_REVIEW_PREF_KEY = "weekly_review";

/** Parse a stored preferences value into a WeeklyReview (defaults on garbage). */
export function parseWeeklyReview(raw: unknown): WeeklyReview {
  const r = weeklyReviewSchema.safeParse(raw ?? {});
  return r.success ? r.data : weeklyReviewSchema.parse({});
}

/** Configured = the user has chosen a review weekday (gates the rail icon). */
export function isReviewConfigured(wr: WeeklyReview): boolean {
  return wr.dueWeekday !== null;
}

/**
 * The ordered steps for the CURRENT cycle: template steps plus this-cycle extras,
 * laid out by the cycle's saved order (with any not-yet-ordered steps appended
 * template-first). Pure so server and client render the same sequence.
 */
export function composeReviewSteps(wr: WeeklyReview): ReviewStep[] {
  const byId = new Map<string, ReviewStep>();
  for (const s of wr.steps) byId.set(s.id, s);
  for (const s of wr.cycle.extras) byId.set(s.id, s);

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of wr.cycle.order) {
    if (byId.has(id) && !seen.has(id)) {
      ids.push(id);
      seen.add(id);
    }
  }
  // Append anything the saved order didn't cover (new template steps first,
  // then extras) so a freshly-added step still shows.
  for (const s of [...wr.steps, ...wr.cycle.extras]) {
    if (!seen.has(s.id)) {
      ids.push(s.id);
      seen.add(s.id);
    }
  }
  return ids.map((id) => byId.get(id)!);
}

/**
 * Apply a new full step-id order. The relative order of TEMPLATE steps persists
 * globally (so a reorder carries across reviews); extras and the exact
 * interleaving are saved on the cycle only.
 */
export function reorderReviewSteps(wr: WeeklyReview, orderedIds: string[]): WeeklyReview {
  const tmpl = new Map(wr.steps.map((s) => [s.id, s]));
  const extra = new Map(wr.cycle.extras.map((s) => [s.id, s]));
  const cleanOrder = orderedIds.filter((id) => tmpl.has(id) || extra.has(id));

  const nextTemplate = [
    ...cleanOrder.filter((id) => tmpl.has(id)),
    ...wr.steps.filter((s) => !cleanOrder.includes(s.id)).map((s) => s.id),
  ].map((id) => tmpl.get(id)!);
  const nextExtras = [
    ...cleanOrder.filter((id) => extra.has(id)),
    ...wr.cycle.extras.filter((s) => !cleanOrder.includes(s.id)).map((s) => s.id),
  ].map((id) => extra.get(id)!);

  return {
    ...wr,
    steps: nextTemplate,
    cycle: { ...wr.cycle, extras: nextExtras, order: cleanOrder },
  };
}

/** Start a fresh cycle keyed by `key`: keep the template, drop extras/done/order. */
export function resetReviewCycle(wr: WeeklyReview, key: string): WeeklyReview {
  return { ...wr, cycle: { key, extras: [], done: [], order: [] } };
}
