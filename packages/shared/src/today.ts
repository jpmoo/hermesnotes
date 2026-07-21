import { z } from "zod";

/**
 * A Today sheet is an ordered list of sections. Three standard sections always
 * exist and can be reordered but not removed; the user may add collection or
 * note sections and reorder/remove those.
 */
export const STANDARD_TODAY_SECTIONS = ["scratchpad", "relevant", "activity"] as const;
export type StandardTodaySection = (typeof STANDARD_TODAY_SECTIONS)[number];

export const todaySectionSchema = z.union([
  z.object({ t: z.enum(STANDARD_TODAY_SECTIONS) }),
  z.object({ t: z.literal("collection"), id: z.string().uuid() }),
  z.object({ t: z.literal("block"), id: z.string().uuid() }),
]);
export type TodaySection = z.infer<typeof todaySectionSchema>;

export const todayLayoutSchema = z.array(todaySectionSchema);
export type TodayLayout = z.infer<typeof todayLayoutSchema>;

/**
 * Normalize a stored layout: drop malformed entries and duplicates, then ensure
 * every standard section is present (missing ones appended in canonical order),
 * so the fixed sections can never be lost.
 */
export function normalizeTodayLayout(value: unknown): TodayLayout {
  const parsed = todayLayoutSchema.safeParse(value);
  const raw: TodayLayout = parsed.success ? parsed.data : [];
  const seen = new Set<string>();
  const out: TodayLayout = [];
  for (const s of raw) {
    const key = s.t === "collection" || s.t === "block" ? `${s.t}:${s.id}` : s.t;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  for (const std of STANDARD_TODAY_SECTIONS) {
    if (!seen.has(std)) out.push({ t: std });
  }
  return out;
}
