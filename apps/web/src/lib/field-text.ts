import { optionLabel, type FieldDef } from "@hermes/shared";
import { fmtWhen } from "./format.ts";

/** A field being shown alongside a block because the list is sorted by it. */
export interface ShownField {
  field: FieldDef;
  /** Which end of a datespan, when the sort names one. */
  part?: "start" | "end";
  label: string;
}

/**
 * A field's value as a short piece of text — for reading, not editing.
 *
 * Only what can be said in a few characters: a reference is a uuid and an
 * attachment list is a file store, and neither reads as anything useful at this
 * size, so both come back empty and the caller shows nothing rather than
 * showing noise.
 */
export function fieldText(field: FieldDef, value: unknown, part?: "start" | "end"): string {
  if (field.type === "datespan") {
    const span = (value ?? {}) as { start?: unknown; end?: unknown };
    const v = part ? span[part] : (span.start ?? span.end);
    return typeof v === "string" && v ? fmtWhen(v) : "";
  }
  if (value == null || value === "") return "";
  switch (field.type) {
    case "date":
    case "datetime":
      return typeof value === "string" ? fmtWhen(value) : "";
    case "status":
    case "select":
      return optionLabel(field, String(value));
    case "boolean":
      return value ? "Yes" : "No";
    case "number":
      return field.units ? `${String(value)} ${field.units}` : String(value);
    case "reference":
    case "attachments":
      return "";
    default: {
      const s = String(value).replace(/\s+/g, " ").trim();
      return s.length > 60 ? `${s.slice(0, 59)}…` : s;
    }
  }
}

/** The sort levels that name a property, resolved against the fields on offer. */
export function shownFields(
  levels: { key: string }[],
  fields: FieldDef[],
): ShownField[] {
  const out: ShownField[] = [];
  for (const lv of levels) {
    if (!lv.key.startsWith("prop:")) continue;
    const raw = lv.key.slice(5);
    const part = raw.endsWith(".start") ? "start" : raw.endsWith(".end") ? "end" : undefined;
    const key = part ? raw.slice(0, part === "start" ? -6 : -4) : raw;
    const field = fields.find((f) => f.key === key);
    if (!field) continue;
    const base = field.label?.trim() || key.replace(/_/g, " ");
    out.push({
      field,
      part,
      label: part
        ? `${base} · ${(part === "start" ? field.startLabel : field.endLabel)?.trim() || (part === "start" ? "Start" : "End")}`
        : base,
    });
  }
  return out;
}
