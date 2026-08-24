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

/**
 * How one of a type's fields fills one slot of a profile: a field key, or one
 * half of a compound field.
 *
 * A producer's single datespan is the task profile's `start` and `due` both, and
 * the labels on it ("Available", "Due") are that producer's own words — never a
 * vocabulary to match against.
 */
export const profileMappingSchema = z.union([
  z.string(),
  z.object({ field: z.string(), part: z.enum(["start", "end"]).optional() }),
]);

/**
 * What this type *is*, said out loud, in a vocabulary a stranger can read.
 *
 * The rule at the top of this file — that nothing outside a property schema may
 * special-case a type — leaves a gap it never closed: a consumer can be told not
 * to look at the name, but nothing tells it what to look at instead. Talaria's
 * seam works a type out from its shape and then falls back to matching seeded
 * names, and its own comment admits the name is "the best evidence available
 * when the shape says nothing". This is the shape saying something.
 *
 * A type may declare several profiles — a Meeting is an event to a calendar and
 * a note to a notebook, and neither has to be told which it "really" is. A type
 * may declare none, and that is an answer: a Recipe with a `status` field whose
 * options include `done` is still not a task, and only the person who made it
 * could have said so.
 *
 * Names outside the vocabulary are kept, not rejected. That is how a vocabulary
 * grows without a committee sitting.
 */
export const typeProfilesSchema = z.record(z.record(z.unknown()));
export type TypeProfiles = z.infer<typeof typeProfilesSchema>;

export const propertySchemaSchema = z
  .object({
    fields: z.array(fieldDefSchema),
    /** What this type is, in profile vocabulary (see typeProfilesSchema). */
    profiles: typeProfilesSchema.optional(),
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
  // Read through the task profile rather than off `status_field` directly.
  // For every type that has ever existed here the two are the same thing —
  // profilesOf derives that profile from status_field and complete_values, so
  // the answer does not move. What changes is that a type which *declares* its
  // completion, in the vocabulary a stranger can read, is now understood by the
  // app that asked it to declare. Declaring something and then not reading it is
  // worse than never asking.
  const task = profilesOf(schema).find((p) => p.name === "task");
  const complete = task?.map.completeValues;
  if (!task || !Array.isArray(complete) || !complete.length) return false;
  const current = readProfile(schema, properties, "status");
  return typeof current === "string" && (complete as unknown[]).includes(current);
}

/** The profile vocabulary a consumer can rely on. Anything else is carried, not read. */
export const PROFILE_NAMES = ["task", "event", "contact", "note"] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];

export interface ResolvedProfile {
  name: ProfileName;
  map: Record<string, unknown>;
  /**
   * True when nobody declared this and it was worked out from the schema's
   * shape. A guess that says it is a guess can be corrected later; one that
   * passes itself off as a declaration becomes the user's data.
   */
  derived: boolean;
}

/**
 * What a type declares itself to be — falling back, for `task` only, to what the
 * schema has always implied.
 *
 * `status_field` plus `complete_values` is a task profile that Hermes has been
 * keeping without a name since the beginning: it says which field carries
 * completion and which of its values mean finished, which is exactly what a
 * stranger needs and exactly what the profile asks for. Deriving it costs
 * nothing and is certain.
 *
 * Nothing else is derived. `event`, `contact` and `note` can only be guessed at
 * from field shapes, and a wrong guess written into a user's type is worse than
 * no answer at all — the format is explicit that an absent declaration is
 * information rather than an invitation to infer.
 */
export function profilesOf(
  schema: PropertySchema | null | undefined,
  opts: { isText?: boolean } = {},
): ResolvedProfile[] {
  const out: ResolvedProfile[] = [];
  const declared = schema?.profiles ?? {};
  for (const name of Object.keys(declared)) {
    if ((PROFILE_NAMES as readonly string[]).includes(name)) {
      out.push({ name: name as ProfileName, map: declared[name] as Record<string, unknown>, derived: false });
    }
  }
  // A text type is a note. This is the second derivation that is safe rather
  // than convenient: the body is `content` by definition for these, and Hermes
  // has always treated isText as settling the question.
  if (!out.some((p) => p.name === "note") && opts.isText) {
    out.push({ name: "note", map: { title: "title", body: "content" }, derived: true });
  }
  if (!out.some((p) => p.name === "task") && schema?.status_field && schema.complete_values?.length) {
    out.push({
      name: "task",
      map: {
        title: "title",
        status: schema.status_field,
        completeValues: schema.complete_values,
        ...datespanSlots(schema),
      },
      derived: true,
    });
  }
  return out;
}

/**
 * Whether a type declares a named profile — including names outside the v0
 * vocabulary.
 *
 * `profilesOf` filters to what a stranger can consume. This asks the raw
 * question, which is what a surface reaching for a profile of its own needs:
 * `project` is not in v0, and the format's answer to that is to declare it and
 * see whether it earns its place, not to wait for a committee.
 */
export function declaresProfile(schema: PropertySchema | null | undefined, name: string): boolean {
  return Boolean(schema?.profiles && Object.prototype.hasOwnProperty.call(schema.profiles, name));
}

/** The first datespan a type has, offered as the task profile's two ends. */
function datespanSlots(schema: PropertySchema): Record<string, unknown> {
  const span = schema.fields.find((f) => f.type === "datespan");
  if (span) return { start: { field: span.key, part: "start" }, due: { field: span.key, part: "end" } };
  const single = schema.fields.find((f) => f.type === "date" || f.type === "datetime");
  return single ? { due: single.key } : {};
}

/**
 * One value read through a profile rather than off a field name.
 *
 * This is the call that replaces knowing what a producer calls things. It is
 * deliberately not clever: if the mapping doesn't say, the answer is nothing.
 */
export function readProfile(
  schema: PropertySchema | null | undefined,
  properties: Record<string, unknown>,
  key: string,
  profile: ProfileName = "task",
  /** A text block's body, which lives outside the property bag. */
  content?: string | null,
): unknown {
  const p = profilesOf(schema, { isText: content !== undefined }).find((x) => x.name === profile);
  const spec = p?.map[key];
  // The one name that isn't a field: a text block keeps its body in `content`,
  // and a profile that wants the body has to be able to say so.
  if (spec === "content") return blank(content);
  if (typeof spec === "string") return blank(properties[spec]);
  if (spec && typeof spec === "object") {
    const { field, part } = spec as { field?: string; part?: string };
    if (!field) return undefined;
    const v = properties[field];
    if (v === null || v === undefined) return undefined;
    return blank(part ? (v as Record<string, unknown>)[part] : v);
  }
  return undefined;
}

/**
 * An empty string is not a value.
 *
 * A field opened and left alone stores "" here all the time — six datespans in
 * one real library — and a reader that takes it at face value shows a date that
 * fails to parse rather than a blank.
 */
const blank = (v: unknown): unknown => (v === "" ? undefined : v);

/**
 * Strip values that mean nothing.
 *
 * A date field opened and left alone stores `""`, and a datespan whose start was
 * cleared keeps the key with an empty string in it. Neither is a value. The
 * interchange format now says so outright — an empty string is absent, and a
 * consumer must read it that way — but a producer that keeps writing one is
 * still handing every other tool something to be wrong about, and half of them
 * will parse it into the epoch or today rather than into nothing.
 *
 * Done on the way in rather than in a form, so it holds for every client: the
 * app, an agent over MCP, the daemon's write queue, and whatever comes next.
 */
export function stripBlankDates(
  schema: PropertySchema | null | undefined,
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...properties };
  for (const f of schema?.fields ?? []) {
    const v = out[f.key];
    if (f.type === "date" || f.type === "datetime") {
      if (v === "") delete out[f.key];
    } else if (f.type === "datespan" && v && typeof v === "object") {
      const span = { ...(v as Record<string, unknown>) };
      for (const end of ["start", "end"]) if (span[end] === "") delete span[end];
      // A span with neither end left is not a span.
      out[f.key] = span.start === undefined && span.end === undefined ? undefined : span;
      if (out[f.key] === undefined) delete out[f.key];
    }
  }
  return out;
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
