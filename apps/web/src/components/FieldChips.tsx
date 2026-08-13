import { fieldText, type ShownField } from "../lib/field-text.ts";

/**
 * The properties a list is sorted by, shown on the block they belong to.
 *
 * A list ordered by something you can't see is a list in an order you can't
 * account for — a collapsed card gives its title and nothing else, and a chip
 * even less. Named on the compact forms ("Due · 3 Sep") because there's no
 * surrounding form to read the value against; a full card already labels its
 * own fields, and doesn't need these at all.
 */
export function FieldChips({
  fields,
  properties,
  compact = false,
}: {
  fields: ShownField[];
  properties: Record<string, unknown>;
  /** Chips view: one line, no labels, whatever fits. */
  compact?: boolean;
}) {
  if (fields.length === 0) return null;
  const shown = fields
    .map((f) => ({ f, text: fieldText(f.field, properties[f.field.key], f.part) }))
    .filter((x) => x.text);
  if (shown.length === 0) return null;
  return (
    <span className={`fld-chips${compact ? " compact" : ""}`}>
      {shown.map(({ f, text }) => (
        <span className="fld-chip" key={`${f.field.key}.${f.part ?? ""}`}>
          {!compact && <span className="fld-chip-label">{f.label}</span>}
          <span className="fld-chip-value">{text}</span>
        </span>
      ))}
    </span>
  );
}
