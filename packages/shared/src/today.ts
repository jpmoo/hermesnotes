import { z } from "zod";

/**
 * A Today sheet is an ordered list of sections. Three standard sections always
 * exist and can be reordered but not removed; the user may add collection or
 * note sections and reorder/remove those.
 */
export const STANDARD_TODAY_SECTIONS = ["scratchpad", "relevant", "activity"] as const;
export type StandardTodaySection = (typeof STANDARD_TODAY_SECTIONS)[number];

/** A user-added section: a collection (canvas/table/…) or a single note block. */
export const customTodaySectionSchema = z.union([
  z.object({ t: z.literal("collection"), id: z.string().uuid() }),
  z.object({ t: z.literal("block"), id: z.string().uuid() }),
]);
export type CustomTodaySection = z.infer<typeof customTodaySectionSchema>;

export const todaySectionSchema = z.union([
  z.object({ t: z.enum(STANDARD_TODAY_SECTIONS) }),
  z.object({ t: z.literal("collection"), id: z.string().uuid() }),
  z.object({ t: z.literal("block"), id: z.string().uuid() }),
]);
export type TodaySection = z.infer<typeof todaySectionSchema>;

export const todayLayoutSchema = z.array(todaySectionSchema);
export type TodayLayout = z.infer<typeof todayLayoutSchema>;

/** Stable key for a section: standard sections key on their name, custom ones
 * on type+id, so a given collection/note appears at most once per sheet. */
export function sectionKey(s: TodaySection): string {
  return s.t === "collection" || s.t === "block" ? `${s.t}:${s.id}` : s.t;
}

// ── Date-scoped defaults ("all Dailies" / "today and future") ──────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A default (cross-day) layout entry: a custom section that appears on every
 * Today sheet whose date falls in the half-open range `[from, until)`.
 * `from = null` means "since the beginning of time" (all past days); `until =
 * null` means "forever" (all future days). `after` anchors the section just
 * below one of the standard sections (e.g. right under the scratchpad).
 *
 * A single section may hold several disjoint entries — e.g. added to all
 * Dailies, later removed from today forward — so storage is a flat list that
 * `coalesceDefaults` keeps tidy.
 */
export const defaultTodayEntrySchema = z.object({
  section: customTodaySectionSchema,
  from: z.string().regex(DATE_RE).nullable(),
  until: z.string().regex(DATE_RE).nullable(),
  after: z.enum(STANDARD_TODAY_SECTIONS).default("scratchpad"),
});
export type DefaultTodayEntry = z.infer<typeof defaultTodayEntrySchema>;

export const defaultTodayLayoutSchema = z.array(defaultTodayEntrySchema);
export type DefaultTodayLayout = z.infer<typeof defaultTodayLayoutSchema>;

/** The temporal scope of an add/remove: this day, this day onward, or every day. */
export const todayScopeSchema = z.enum(["today", "today_forward", "all"]);
export type TodayScope = z.infer<typeof todayScopeSchema>;

/** Does a default entry's [from, until) range include `date`? */
export function rangeCovers(e: Pick<DefaultTodayEntry, "from" | "until">, date: string): boolean {
  return (e.from == null || e.from <= date) && (e.until == null || date < e.until);
}

/**
 * Normalize a stored per-day layout: drop malformed entries and duplicates,
 * then ensure every standard section is present (missing ones appended in
 * canonical order), so the fixed sections can never be lost.
 */
export function normalizeTodayLayout(value: unknown): TodayLayout {
  const parsed = todayLayoutSchema.safeParse(value);
  const raw: TodayLayout = parsed.success ? parsed.data : [];
  const seen = new Set<string>();
  const out: TodayLayout = [];
  for (const s of raw) {
    const key = sectionKey(s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  for (const std of STANDARD_TODAY_SECTIONS) {
    if (!seen.has(std)) out.push({ t: std });
  }
  return out;
}

/** Parse a stored default layout, dropping malformed entries. */
export function normalizeDefaultLayout(value: unknown): DefaultTodayLayout {
  if (!Array.isArray(value)) return [];
  const out: DefaultTodayLayout = [];
  for (const raw of value) {
    const parsed = defaultTodayEntrySchema.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
  }
  return coalesceDefaults(out);
}

/**
 * Compose the layout shown for a given date: the day's own stored layout, with
 * covering default sections injected just after their anchor (unless the day
 * suppresses them or already contains them). Deterministic and side-effect free
 * so the server and the web app render identically.
 */
export function composeTodayLayout(
  dayLayout: unknown,
  suppress: string[] | undefined,
  defaults: DefaultTodayLayout,
  date: string,
): TodayLayout {
  const base = normalizeTodayLayout(dayLayout);
  const present = new Set(base.map(sectionKey));
  const hidden = new Set(suppress ?? []);
  const out: TodayLayout = [];
  for (const s of base) {
    out.push(s);
    if (s.t === "collection" || s.t === "block") continue;
    // Right after a standard anchor, inject the defaults pinned to it.
    for (const e of defaults) {
      if (e.after !== s.t || !rangeCovers(e, date)) continue;
      const key = sectionKey(e.section);
      if (present.has(key) || hidden.has(key)) continue;
      present.add(key);
      out.push(e.section);
    }
  }
  return out;
}

/** Merge overlapping/adjacent ranges for the same section so the list stays
 * minimal. Entries keep the anchor of the earliest range in each group. */
export function coalesceDefaults(defaults: DefaultTodayLayout): DefaultTodayLayout {
  const byKey = new Map<string, DefaultTodayEntry[]>();
  for (const e of defaults) {
    const key = sectionKey(e.section);
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(e);
  }
  const out: DefaultTodayLayout = [];
  for (const group of byKey.values()) {
    // Sort by start (null = -infinity), then greedily union touching ranges.
    const sorted = [...group].sort((a, b) => (a.from ?? "") .localeCompare(b.from ?? ""));
    let cur: DefaultTodayEntry | null = null;
    for (const e of sorted) {
      if (!cur) {
        cur = { ...e };
        continue;
      }
      // Overlap or touch when cur has no end, or e starts at/before cur's end.
      const touches = cur.until == null || e.from == null || e.from <= cur.until;
      if (touches) {
        cur.until = cur.until == null || e.until == null ? null : e.until > cur.until ? e.until : cur.until;
      } else {
        out.push(cur);
        cur = { ...e };
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

/**
 * Apply an "add" at cross-day scope. `today` scope is a per-day edit handled by
 * the caller (this only covers the default layout). Returns new defaults.
 */
export function addToDefaults(
  defaults: DefaultTodayLayout,
  section: CustomTodaySection,
  after: StandardTodaySection,
  scope: Exclude<TodayScope, "today">,
  date: string,
): DefaultTodayLayout {
  const from = scope === "all" ? null : date;
  return coalesceDefaults([...defaults, { section, from, until: null, after }]);
}

/**
 * Apply a "remove" at cross-day scope to the default layout:
 *  - `all`: drop every range for the section.
 *  - `today_forward`: stop the section from `date` onward — cap ranges that
 *    extend into the future, keep the part strictly before `date`.
 * `today` scope is a per-day suppression handled by the caller.
 */
export function removeFromDefaults(
  defaults: DefaultTodayLayout,
  key: string,
  scope: Exclude<TodayScope, "today">,
  date: string,
): DefaultTodayLayout {
  if (scope === "all") return defaults.filter((e) => sectionKey(e.section) !== key);
  const out: DefaultTodayLayout = [];
  for (const e of defaults) {
    if (sectionKey(e.section) !== key) {
      out.push(e);
      continue;
    }
    // Entirely before the cutoff → keep as-is.
    if (e.until != null && e.until <= date) {
      out.push(e);
      continue;
    }
    // Starts on/after the cutoff → dropped entirely.
    if (e.from != null && e.from >= date) continue;
    // Straddles the cutoff → keep only the part before `date`.
    out.push({ ...e, until: date });
  }
  return coalesceDefaults(out);
}
