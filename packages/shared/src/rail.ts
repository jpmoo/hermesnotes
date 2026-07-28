import { z } from "zod";

/**
 * Customizable left-rail layout. The rail's brand/pin (top) and Dark mode /
 * Settings / Sign out (bottom) are fixed; everything between is an ordered,
 * user-arrangeable list of buttons and dividers stored in synced preferences
 * under {@link RAIL_LAYOUT_PREF_KEY}.
 */

/** The buttons that can be shown/hidden/reordered on the rail. */
export const RAIL_BUTTON_IDS = [
  "new",
  "search",
  "today",
  "favorites",
  "blocks",
  "collections",
  "types",
  "review",
  "archive",
] as const;
export type RailButtonId = (typeof RAIL_BUTTON_IDS)[number];

export type RailItem =
  | { kind: "button"; id: RailButtonId; hidden?: boolean }
  | { kind: "line" } // a divider line
  | { kind: "flex" } // a flexible spacer (pushes following items down)
  | { kind: "gap" }; // a small fixed-height gap

export const railItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("button"), id: z.enum(RAIL_BUTTON_IDS), hidden: z.boolean().optional() }),
  z.object({ kind: z.literal("line") }),
  z.object({ kind: z.literal("flex") }),
  z.object({ kind: z.literal("gap") }),
]);
export const railLayoutSchema = z.array(railItemSchema).max(60);
export type RailLayout = z.infer<typeof railLayoutSchema>;

export const RAIL_LAYOUT_PREF_KEY = "rail_layout";

/** The stock arrangement (matches the app's default rail). */
export const DEFAULT_RAIL: RailLayout = [
  { kind: "button", id: "new" },
  { kind: "button", id: "search" },
  { kind: "line" },
  { kind: "button", id: "today" },
  { kind: "line" },
  { kind: "button", id: "favorites" },
  { kind: "line" },
  { kind: "button", id: "blocks" },
  { kind: "button", id: "collections" },
  { kind: "button", id: "types" },
  { kind: "line" },
  { kind: "button", id: "review" },
  { kind: "line" },
  { kind: "button", id: "archive" },
];

/**
 * Parse a stored layout into a valid one: drop garbage, dedupe buttons (keep the
 * first occurrence), and append any known button the config is missing (so a
 * newly-added rail button appears rather than vanishing). Missing/empty → default.
 */
export function normalizeRail(raw: unknown): RailLayout {
  const parsed = railLayoutSchema.safeParse(raw);
  if (!parsed.success || parsed.data.length === 0) return DEFAULT_RAIL;
  const seen = new Set<RailButtonId>();
  const out: RailLayout = [];
  for (const it of parsed.data) {
    if (it.kind === "button") {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
    }
    out.push(it);
  }
  for (const id of RAIL_BUTTON_IDS) {
    if (!seen.has(id)) out.push({ kind: "button", id });
  }
  return out;
}
