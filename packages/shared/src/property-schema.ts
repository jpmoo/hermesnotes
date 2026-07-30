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
  "longtext", // paragraph-sized markdown editor (expands, live/raw), like a note body
  "date", // legacy date-only; rendered with the date/time picker (time optional)
  "datetime", // "Date/Time": a single calendar + 12-hour time; value "YYYY-MM-DDTHH:mm"
  "datespan", // "Date/Time Span": { start, end } each "YYYY-MM-DDTHH:mm", with labels
  "number",
  "boolean",
  "select",
  "status",
  "url",
  "reference", // points at another block (of ref_type_id); value is that block's id
  "attachments", // interactive file uploads stored server-side, keyed by block id
  "recurrence", // task-only: a recurrence rule edited in a modal
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
  /**
   * for select/status fields — the values actually stored on a block. What the
   * reader sees can differ: see `optionLabels`.
   */
  options: z.array(z.string()).optional(),
  /**
   * select/status fields: per-option display label (option value -> label). Only
   * holds the entries that differ; a value with no entry here is its own label,
   * which is why every type predating this keeps working untouched.
   */
  optionLabels: z.record(z.string()).optional(),
  /** status fields: per-option Lucide icon key (option value -> kebab icon key) */
  optionIcons: z.record(z.string()).optional(),
  /** status fields: per-option color (option value -> color) */
  optionColors: z.record(z.string()).optional(),
  /** for reference fields: the block_type id this field points at */
  refTypeId: z.string().uuid().optional(),
  /** for datespan fields: labels for the two endpoints (e.g. "Available" / "Due") */
  startLabel: z.string().optional(),
  endLabel: z.string().optional(),
  /** for number fields: a unit shown after the value, e.g. "minutes" */
  units: z.string().optional(),
  required: z.boolean().optional(),
  /** built-in core field: can be edited but not removed from the type. */
  locked: z.boolean().optional(),
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
    .filter(
      (f) =>
        f.includeEmbed &&
        f.type !== "reference" &&
        f.type !== "attachments" &&
        f.type !== "recurrence" &&
        f.type !== "datespan",
    )
    .sort((a, b) => a.order - b.order)
    .map((f) => properties[f.key])
    .filter((v): v is string | number => v !== null && v !== undefined && v !== "")
    .map((v) => String(v))
    .join("\n");
}

/**
 * What to show for a select/status option. Falls back to the stored value with
 * underscores opened out, so an option that was never given a label reads the way
 * it always did.
 */
export function optionLabel(field: FieldDef, value: string): string {
  const custom = field.optionLabels?.[value];
  return custom && custom.trim() ? custom : value.replace(/_/g, " ");
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
