import { z } from "zod";

/**
 * property_schema — the single source of truth for a block_type's editing form,
 * embedding pipeline, and status/kanban logic (design doc §3, §7).
 *
 * Everything is declarative: no per-type hardcoded logic anywhere else in the
 * codebase should special-case a block type. If you find yourself writing
 * `if (blockType.name === 'task')`, the answer belongs here instead.
 */

export const fieldTypeSchema = z.enum([
  "text",
  "date",
  "datetime",
  "number",
  "boolean",
  "select",
  "status",
  "url",
]);
export type FieldType = z.infer<typeof fieldTypeSchema>;

export const fieldDefSchema = z.object({
  /** stable key into blocks.properties jsonb */
  key: z.string().min(1),
  type: fieldTypeSchema,
  /** human label for the editing form; defaults to a title-cased key when absent */
  label: z.string().optional(),
  /**
   * Explicit ordering. Drives BOTH form field order AND embed_source
   * concatenation order — never rely on jsonb array order surviving round-trips.
   */
  order: z.number().int(),
  /** whether this field's value is concatenated into embed_source */
  includeEmbed: z.boolean().default(false),
  /** for select/status fields */
  options: z.array(z.string()).optional(),
  required: z.boolean().optional(),
});
export type FieldDef = z.infer<typeof fieldDefSchema>;

export const propertySchemaSchema = z
  .object({
    fields: z.array(fieldDefSchema),
    /** which field (by key) carries completion state, if any (§7) */
    status_field: z.string().nullable().optional(),
    /** option values that count as "complete" for checklist/kanban logic */
    complete_values: z.array(z.string()).optional(),
    /** default value written when a status field is reset/unchecked */
    default_value: z.string().nullable().optional(),
  })
  .superRefine((schema, ctx) => {
    // Convention (doc §3): every non-text block type must declare a `title` field.
    // (Enforced at block-type-creation time; text blocks skip property_schema.)
    const keys = schema.fields.map((f) => f.key);
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    if (dupes.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate field keys: ${[...new Set(dupes)].join(", ")}`,
      });
    }
    if (schema.status_field && !keys.includes(schema.status_field)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `status_field '${schema.status_field}' is not a declared field`,
      });
    }
  });
export type PropertySchema = z.infer<typeof propertySchemaSchema>;

/**
 * Generic embed_source derivation (doc §4). Text blocks are the exception and
 * use `content` directly — this helper is for schema-driven (non-text) blocks.
 */
export function deriveEmbedSource(
  schema: PropertySchema,
  properties: Record<string, unknown>,
): string {
  return schema.fields
    .filter((f) => f.includeEmbed)
    .sort((a, b) => a.order - b.order)
    .map((f) => properties[f.key])
    .filter((v): v is string | number => v !== null && v !== undefined && v !== "")
    .map((v) => String(v))
    .join("\n");
}

/** Whether a block's current status counts as complete (doc §7). */
export function isComplete(
  schema: PropertySchema,
  properties: Record<string, unknown>,
): boolean {
  if (!schema.status_field || !schema.complete_values?.length) return false;
  const current = properties[schema.status_field];
  return typeof current === "string" && schema.complete_values.includes(current);
}
