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
  /** longtext fields: a template block whose text a new block starts with */
  templateId: z.string().uuid().nullish(),
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
/**
 * The field a type keeps its prose in — the one a note's body, an extracted
 * selection, or an assistant's notes should land in.
 *
 * By name first, because "description" is what the built-ins call it and
 * "notes" is what people rename it to; then by type, because a type with a
 * single long-text field means that one whatever it's called. Null when there's
 * nowhere to put prose at all, which is worth knowing rather than guessing at:
 * every caller here is holding text it must not drop.
 */
export function bodyFieldKey(schema: PropertySchema | null | undefined): string | null {
  const long = (schema?.fields ?? []).filter((f) => f.type === "longtext");
  return (
    long.find((f) => f.key === "description")?.key ??
    long.find((f) => f.key === "notes")?.key ??
    long[0]?.key ??
    null
  );
}

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

/** The calendar day a stored date/datetime belongs to, or null if it isn't one. */
export function dayOf(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  const d = v.split("T")[0];
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

/**
 * Whether any dated field on a block touches the days [start, end], inclusive.
 *
 * Dates only: the time of day says where something sits on a day, never which
 * day it belongs to. A datespan counts if it overlaps the range at all — a task
 * available Monday and due Friday is a Wednesday's business too, which is the
 * whole reason a range asks rather than each day asking separately.
 */
export function datedInRange(
  schema: PropertySchema | null | undefined,
  props: Record<string, unknown>,
  start: string,
  end: string,
): boolean {
  if (!schema) return false;
  for (const f of schema.fields) {
    if (f.type === "datetime" || f.type === "date") {
      const d = dayOf(props[f.key]);
      if (d && d >= start && d <= end) return true;
    } else if (f.type === "datespan") {
      const span = props[f.key] as { start?: unknown; end?: unknown } | undefined;
      if (!span || typeof span !== "object") continue;
      const s = dayOf(span.start);
      const e = dayOf(span.end);
      if (s && e) {
        if (s <= end && e >= start) return true;
      } else if (s) {
        if (s >= start && s <= end) return true;
      } else if (e) {
        if (e >= start && e <= end) return true;
      }
    }
  }
  return false;
}
