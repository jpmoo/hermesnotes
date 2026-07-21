import type { FieldDef } from "@hermes/shared";
import { AttachmentsField } from "./AttachmentsField.tsx";
import { DateTimePicker } from "./DateTimePicker.tsx";
import { ReferenceInput } from "./ReferenceInput.tsx";

/** datespan value shape: two local wall-clock strings. */
interface Span {
  start?: string;
  end?: string;
}

/** Renders the appropriate control for a property_schema field (design doc §3). */
export function FieldInput({
  field,
  value,
  onChange,
  blockId,
}: {
  field: FieldDef;
  value: unknown;
  onChange: (value: unknown) => void;
  blockId?: string;
}) {
  const str = value == null ? "" : String(value);

  switch (field.type) {
    case "attachments":
      return blockId ? (
        <AttachmentsField blockId={blockId} />
      ) : (
        <span className="hint">Save the block first to attach files.</span>
      );
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
    case "datetime":
      return <DateTimePicker value={str} onChange={(v) => onChange(v)} />;
    case "datespan": {
      const span = (value ?? {}) as Span;
      const setSpan = (patch: Span) => onChange({ ...span, ...patch });
      return (
        <div className="span-field">
          <div className="span-leg">
            <span className="span-label">{field.startLabel?.trim() || "Start"}</span>
            <DateTimePicker
              value={span.start ?? ""}
              onChange={(v) => setSpan({ start: v })}
              placeholder="Set start"
            />
          </div>
          <div className="span-leg">
            <span className="span-label">{field.endLabel?.trim() || "End"}</span>
            <DateTimePicker
              value={span.end ?? ""}
              onChange={(v) => setSpan({ end: v })}
              placeholder="Set end"
            />
          </div>
        </div>
      );
    }
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
