import type { FieldDef } from "@hermes/shared";
import { ExternalLink } from "lucide-react";
import { optionLabel } from "@hermes/shared";
import type { ReactNode } from "react";
import { AttachmentsField } from "./AttachmentsField.tsx";
import { DateTimePicker } from "./DateTimePicker.tsx";
import { LongTextField } from "./LongTextField.tsx";
import { MentionTextInput } from "./MentionTextInput.tsx";
import { NumberField } from "./NumberField.tsx";
import { isOverdue } from "../lib/display.ts";
import { useAsOf } from "../lib/as-of.tsx";
import { RecurrenceField } from "./RecurrenceField.tsx";
import { ReferenceInput } from "./ReferenceInput.tsx";

/** datespan value shape: two local wall-clock strings. */
interface Span {
  start?: string;
  end?: string;
}

/** The href a field's whole value points at, if it is just a URL. */
function urlHref(v: string): string | null {
  const t = v.trim();
  if (/^https?:\/\/\S+$/i.test(t)) return t;
  if (/^www\.\S+$/i.test(t)) return `https://${t}`;
  return null;
}

/**
 * Wrap an editable field that currently holds a URL with a click-through, so a
 * meeting link (a calendar event's location is often just a Zoom URL) is
 * reachable without selecting and copying it. `stopPropagation` keeps the
 * enclosing <label> from swallowing the click and focusing the input instead.
 */
function WithOpenLink({ href, children }: { href: string | null; children: ReactNode }) {
  if (!href) return <>{children}</>;
  return (
    <span className="field-with-link">
      {children}
      <a
        className="field-open"
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        title={`Open ${href}`}
        onClick={(e) => e.stopPropagation()}
      >
        <ExternalLink size={13} />
      </a>
    </span>
  );
}

/** Renders the appropriate control for a property_schema field (design doc §3). */
export function FieldInput({
  field,
  value,
  onChange,
  blockId,
  showOverdue = false,
}: {
  field: FieldDef;
  value: unknown;
  onChange: (value: unknown) => void;
  blockId?: string;
  /** Whether an "Overdue" pill may show on a past due date. Only true for
   *  task-like blocks (a type with a status field) that aren't complete — an
   *  event's end date, for instance, isn't "overdue", it just passed. */
  showOverdue?: boolean;
}) {
  const str = value == null ? "" : String(value);
  // On a Daily, "overdue" means overdue as of that day.
  const asOf = useAsOf();

  switch (field.type) {
    case "attachments":
      return blockId ? (
        <AttachmentsField blockId={blockId} />
      ) : (
        <span className="hint">Save the block first to attach files.</span>
      );
    case "longtext":
      return (
        <LongTextField
          value={value}
          onChange={(v) => onChange(v)}
          placeholder={field.label ?? "Write…"}
          blockId={blockId}
        />
      );
    case "recurrence":
      return <RecurrenceField value={value} onChange={onChange} />;
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
      return (
        <DateTimePicker
          value={str}
          onChange={(v) => onChange(v)}
          withTime={field.type === "datetime"}
        />
      );
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
            <span className="span-label">
              {field.endLabel?.trim() || "End"}
              {showOverdue && isOverdue(span.end, asOf) && <span className="overdue-pill">Overdue</span>}
            </span>
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
      return <NumberField value={value} onChange={onChange} units={field.units} />;
    case "url":
      return (
        <WithOpenLink href={urlHref(str)}>
          <input type="url" autoComplete="off" value={str} onChange={(e) => onChange(e.target.value)} />
        </WithOpenLink>
      );
    case "reference":
      return <ReferenceInput refTypeId={field.refTypeId} value={value} onChange={onChange} />;
    case "select":
    case "status":
      return (
        <select value={str} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {optionLabel(field, o)}
            </option>
          ))}
        </select>
      );
    default:
      // Plain text fields: mention-aware (@ / # / | search dropdown, chips).
      // A field holding just a URL (e.g. an event's location) also gets a
      // click-through, since it stays editable text.
      return (
        <WithOpenLink href={urlHref(str)}>
          <MentionTextInput className="field-text" value={str} onChange={(v) => onChange(v)} />
        </WithOpenLink>
      );
  }
}
