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
]);
export type CollectionKind = z.infer<typeof collectionKindSchema>;

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
  z.object({ kind: z.literal("blockType"), typeId: z.string().uuid() }),
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
