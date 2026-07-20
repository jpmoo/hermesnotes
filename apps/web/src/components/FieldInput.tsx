import type { FieldDef } from "@hermes/shared";
import { ReferenceInput } from "./ReferenceInput.tsx";

/** Renders the appropriate control for a property_schema field (design doc §3). */
export function FieldInput({
  field,
  value,
  onChange,
}: {
  field: FieldDef;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const str = value == null ? "" : String(value);

  switch (field.type) {
    case "boolean":
      return (
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          style={{ width: "auto" }}
        />
      );
    case "date":
      return <input type="date" value={str} onChange={(e) => onChange(e.target.value)} />;
    case "datetime":
      return (
        <input type="datetime-local" value={str} onChange={(e) => onChange(e.target.value)} />
      );
    case "number":
      return (
        <input
          type="number"
          value={str}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        />
      );
    case "url":
      return <input type="url" value={str} onChange={(e) => onChange(e.target.value)} />;
    case "reference":
      return <ReferenceInput refTypeId={field.refTypeId} value={value} onChange={onChange} />;
    case "select":
    case "status":
      return (
        <select value={str} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o.replace(/_/g, " ")}
            </option>
          ))}
        </select>
      );
    default:
      return <input type="text" value={str} onChange={(e) => onChange(e.target.value)} />;
  }
}
