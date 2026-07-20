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
]);
export type CollectionKind = z.infer<typeof collectionKindSchema>;

/** Explicit vs. smart membership (doc §6). */
export const membershipModeSchema = z.enum(["explicit", "smart"]);
export type MembershipMode = z.infer<typeof membershipModeSchema>;

/** Smart-collection filter (doc §6). Materialized on write-through. */
export const filterQuerySchema = z.object({
  tags: z.array(z.string()).optional(),
  block_type: z.string().optional(),
  properties_match: z.record(z.unknown()).optional(),
  text_search: z.string().nullable().optional(),
});
export type FilterQuery = z.infer<typeof filterQuerySchema>;

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

export const listFormatSchema = z.enum(["bullet", "ordered", "checklist"]);
export const sortModeSchema = z.enum([
  "manual",
  "alpha",
  "created_at",
  "due_date",
  "custom_field",
]);
