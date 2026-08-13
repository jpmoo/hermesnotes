import { z } from "zod";

/** Collection kinds (doc §5). A collection is a block with collection_kind set. */
export const collectionKindSchema = z.enum([
  "document",
  "list",
  "matrix",
  "kanban",
  "table",
  "masonry",
  "canvas",
  "calendar",
  "rollup",
]);
export type CollectionKind = z.infer<typeof collectionKindSchema>;

/**
 * Rollup collections (`rollup`) — a nesting view rather than a membership one.
 *
 * `roots` names what sits at the top: a collection contributes each of its
 * members as a bucket, a plain block is a bucket on its own. Each entry in
 * `levels` then says how to find what belongs *under* a parent one level up:
 * blocks of some type that point at it through a reference field, and/or — when
 * the parent is itself a collection — its members. So "Projects, then tasks"
 * is one root and one level.
 *
 * Nothing here is membership: a rollup owns no memberships of its own and the
 * blocks it shows keep living wherever they already live.
 */
export const rollupLevelSchema = z.object({
  /** Only blocks of this type (null/absent = any type). */
  typeId: z.string().uuid().nullable().optional(),
  /** Which reference field must point at the parent (absent = any of them). */
  refKey: z.string().nullable().optional(),
  /** When the parent is a collection, count its members as children too. */
  members: z.boolean().optional(),
  /** Label shown on the level in the configuration panel. */
  label: z.string().optional(),
});
export type RollupLevel = z.infer<typeof rollupLevelSchema>;

export const rollupConfigSchema = z.object({
  roots: z.array(z.string().uuid()).default([]),
  levels: z.array(rollupLevelSchema).default([]),
});
export type RollupConfig = z.infer<typeof rollupConfigSchema>;

export const emptyRollup = (): RollupConfig => ({ roots: [], levels: [] });

/** Read a stored rollup config, falling back to an empty one. */
export function normalizeRollup(value: unknown): RollupConfig {
  const parsed = rollupConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : emptyRollup();
}

/** Explicit vs. smart membership (doc §6). */
export const membershipModeSchema = z.enum(["explicit", "smart"]);
export type MembershipMode = z.infer<typeof membershipModeSchema>;

/** Smart-collection filter: an interactive query builder (doc §6). */
export const propertyOpSchema = z.enum([
  "eq",
  "neq",
  "contains",
  "lt",
  "gt",
  "empty",
  "notEmpty",
]);
export type PropertyOp = z.infer<typeof propertyOpSchema>;

export const conditionSchema = z.discriminatedUnion("kind", [
  // `op` is optional so every filter saved before it existed still parses, and
  // reads as "is" — which is what it meant.
  z.object({
    kind: z.literal("blockType"),
    typeId: z.string().uuid(),
    op: z.enum(["is", "isNot"]).optional(),
  }),
  z.object({ kind: z.literal("created"), op: z.enum(["before", "after"]), date: z.string() }),
  z.object({ kind: z.literal("edited"), op: z.enum(["before", "after"]), date: z.string() }),
  z.object({
    kind: z.literal("tag"),
    tag: z.string(),
    // absent = include (kept optional so the recursive group schema stays sound)
    op: z.enum(["include", "exclude"]).optional(),
  }),
  z.object({
    kind: z.literal("property"),
    key: z.string(),
    op: propertyOpSchema,
    value: z.string().optional(),
  }),
  z.object({ kind: z.literal("text"), value: z.string() }),
  z.object({ kind: z.literal("semantic"), value: z.string(), floor: z.number().min(0).max(1) }),
  z.object({ kind: z.literal("hasAttachment"), has: z.boolean() }),
]);
export type Condition = z.infer<typeof conditionSchema>;

/** A group of conditions and nested groups, combined by `match` (all=AND, any=OR). */
export type FilterGroup = {
  kind: "group";
  match: "all" | "any";
  items: Array<Condition | FilterGroup>;
};

export const filterGroupSchema: z.ZodType<FilterGroup> = z.lazy(() =>
  z.object({
    kind: z.literal("group"),
    match: z.enum(["all", "any"]),
    items: z.array(z.union([conditionSchema, filterGroupSchema])),
  }),
);

export const filterQuerySchema = filterGroupSchema;
export type FilterQuery = FilterGroup;

export const emptyGroup = (): FilterGroup => ({ kind: "group", match: "all", items: [] });

/**
 * Reserved sentinel "block type" for querying Daily Notes. Daily notes have no
 * real block type (they're text blocks carrying a `today_note` date) and are
 * hidden from every normal query — so selecting this in a smart-collection query
 * both matches daily notes and lifts that hide filter. It's a valid UUID so it
 * passes the blockType condition schema unchanged.
 */
export const DAILY_NOTE_TYPE_ID = "da110000-0000-4000-8000-000000000000";

/** Whether a filter tree references the Daily Note sentinel type anywhere. */
export function filterUsesDailyNotes(g: FilterGroup): boolean {
  return g.items.some((it) =>
    it.kind === "group"
      ? filterUsesDailyNotes(it)
      : it.kind === "blockType" && it.typeId === DAILY_NOTE_TYPE_ID,
  );
}

/** Accept either the group shape or the legacy {match, conditions[]} shape. */
export function normalizeFilter(value: unknown): FilterGroup {
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (v.kind === "group") {
      const parsed = filterGroupSchema.safeParse(v);
      if (parsed.success) return parsed.data;
    }
    if (Array.isArray(v.conditions)) {
      const items = (v.conditions as unknown[]).filter(
        (c) => conditionSchema.safeParse(c).success,
      ) as Condition[];
      return { kind: "group", match: v.match === "any" ? "any" : "all", items };
    }
  }
  return emptyGroup();
}

/** How a smart collection resolves membership. */
export const smartModeSchema = z.enum(["dynamic", "snapshot"]);
export type SmartMode = z.infer<typeof smartModeSchema>;

/** document region for a membership row (doc §5). */
export const regionSchema = z.enum(["header", "body", "footer"]);
export type Region = z.infer<typeof regionSchema>;

/**
 * membership.context — kind-specific placement data (doc §5).
 * Loosely typed on the wire; each renderer reads the fields it cares about.
 */
export const membershipContextSchema = z
  .object({
    // list
    checked: z.boolean().optional(),
    // matrix / kanban
    row_key: z.string().nullable().optional(),
    col_key: z.string().nullable().optional(),
    // masonry
    size_override: z.object({ w: z.number(), h: z.number() }).optional(),
    collapsed: z.boolean().optional(),
    // canvas
    x: z.number().nullable().optional(),
    y: z.number().nullable().optional(),
    docked: z.boolean().optional(),
    hidden: z.boolean().optional(),
  })
  .passthrough();
export type MembershipContext = z.infer<typeof membershipContextSchema>;

export const listFormatSchema = z.enum(["bullet", "ordered", "checklist", "blocks"]);
export type ListFormat = z.infer<typeof listFormatSchema>;
export const sortModeSchema = z.enum([
  "manual",
  "alpha",
  "created_at",
  "due_date",
  "custom_field",
]);
