import type { FieldType } from "@hermes/shared";

/**
 * What a type *is*, said in a vocabulary a stranger can read.
 *
 * Hermes' own rule is that nothing outside a property schema may special-case a
 * type — no `if (name === "task")` anywhere. That rule tells code what not to
 * look at without ever saying what to look at instead, so every consumer that
 * needed to know ended up guessing from field shapes and falling back to the
 * name anyway. This is the place to stop guessing: the person who made the type
 * says once what it is, and everything downstream reads the answer.
 */

type SlotAccepts = "label" | "date" | "prose" | "text";

interface Slot {
  key: string;
  label: string;
  accepts: SlotAccepts;
  hint?: string;
}

interface ProfileDef {
  name: string;
  label: string;
  blurb: string;
  slots: Slot[];
  /** Outside the v0 vocabulary: other tools keep it and ignore it. */
  proposed?: boolean;
  /** Slots filled from elsewhere in this editor rather than here. */
  fromCompletion?: boolean;
}

const PROFILES: ProfileDef[] = [
  {
    name: "task",
    label: "Task",
    blurb: "Something that can be finished. A tool that knows nothing else about this type can still show it in a to-do list and tick it off.",
    fromCompletion: true,
    slots: [
      { key: "title", label: "Title", accepts: "label" },
      { key: "start", label: "Starts", accepts: "date", hint: "when it can be begun" },
      { key: "due", label: "Due", accepts: "date" },
    ],
  },
  {
    name: "event",
    label: "Event",
    blurb: "Something that happens at a time. A calendar can place it without knowing what you call it.",
    slots: [
      { key: "title", label: "Title", accepts: "label" },
      { key: "start", label: "Starts", accepts: "date" },
      { key: "end", label: "Ends", accepts: "date" },
    ],
  },
  {
    name: "contact",
    label: "Contact",
    blurb: "A person or an organisation.",
    slots: [
      { key: "name", label: "Name", accepts: "label" },
      { key: "email", label: "Email", accepts: "text" },
    ],
  },
  {
    name: "note",
    label: "Note",
    blurb: "Something written. The body is the part worth reading.",
    slots: [
      { key: "title", label: "Title", accepts: "label" },
      { key: "body", label: "Body", accepts: "prose" },
    ],
  },
  {
    name: "project",
    label: "Project",
    proposed: true,
    blurb: "Something other blocks hang off. Not part of the shared vocabulary yet — other tools will carry it through untouched and ignore it, which is how a name earns its place.",
    slots: [{ key: "title", label: "Title", accepts: "label" }],
  },
];

const ACCEPTS: Record<SlotAccepts, FieldType[]> = {
  label: ["text"],
  date: ["date", "datetime", "datespan"],
  prose: ["longtext"],
  text: ["text", "url"],
};

interface EditFieldLike {
  key: string;
  label: string;
  type: FieldType;
}

/** A field, or one end of a datespan — "schedule:end" is the task profile's due date. */
function choicesFor(fields: EditFieldLike[], accepts: SlotAccepts): { value: string; label: string }[] {
  const allowed = ACCEPTS[accepts];
  const out: { value: string; label: string }[] = [];
  for (const f of fields) {
    if (!f.key || !allowed.includes(f.type)) continue;
    const name = f.label?.trim() || f.key;
    if (f.type === "datespan") {
      out.push({ value: `${f.key}:start`, label: `${name} · start` });
      out.push({ value: `${f.key}:end`, label: `${name} · end` });
    } else {
      out.push({ value: f.key, label: name });
    }
  }
  return out;
}

const encode = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const { field, part } = v as { field?: string; part?: string };
    return field ? (part ? `${field}:${part}` : field) : "";
  }
  return "";
};

const decode = (s: string): unknown => {
  if (!s) return undefined;
  const [field, part] = s.split(":");
  return part ? { field, part } : field;
};

export function ProfileDeclaration({
  fields,
  value,
  onChange,
  hasCompletion,
}: {
  fields: EditFieldLike[];
  /** Every declared profile, including names this editor doesn't render. */
  value: Record<string, Record<string, unknown>>;
  onChange: (next: Record<string, Record<string, unknown>>) => void;
  /** Whether the Completion section below has a status field to offer. */
  hasCompletion: boolean;
}) {
  const setSlot = (profile: string, slot: string, raw: string) => {
    const map = { ...(value[profile] ?? {}) };
    const decoded = decode(raw);
    if (decoded === undefined) delete map[slot];
    else map[slot] = decoded;
    onChange({ ...value, [profile]: map });
  };

  const toggle = (def: ProfileDef, on: boolean) => {
    if (!on) {
      const next = { ...value };
      delete next[def.name];
      onChange(next);
      return;
    }
    // Prefill what can be worked out, as a suggestion the person confirms by
    // saving. A guess offered is a different thing from a guess written down.
    const map: Record<string, unknown> = {};
    for (const slot of def.slots) {
      const first = choicesFor(fields, slot.accepts)[0];
      if (!first) continue;
      const named = choicesFor(fields, slot.accepts).find((c) => c.value.split(":")[0] === slot.key);
      map[slot.key] = decode((named ?? first).value);
    }
    onChange({ ...value, [def.name]: map });
  };

  return (
    <div className="prof-decl">
      <div className="prof-decl-head">
        <span className="chrome">What this type is</span>
        <span className="hint">
          Optional, and leaving it blank is an answer. A Recipe with a status field whose options
          include “done” is still not a task, and nothing but you can say so.
        </span>
      </div>

      {PROFILES.map((def) => {
        const on = Boolean(value[def.name]);
        return (
          <div key={def.name} className={`prof-row${on ? " on" : ""}`}>
            <label className="prof-toggle">
              <input type="checkbox" checked={on} onChange={(e) => toggle(def, e.target.checked)} />
              <span>{def.label}</span>
              {def.proposed && <span className="prof-tag">proposed</span>}
            </label>
            <p className="hint prof-blurb">{def.blurb}</p>
            {on && (
              <div className="prof-slots">
                {def.slots.map((slot) => {
                  const choices = choicesFor(fields, slot.accepts);
                  return (
                    <label key={slot.key} className="prof-slot">
                      <span>{slot.label}</span>
                      <select
                        value={encode(value[def.name]?.[slot.key])}
                        onChange={(e) => setSlot(def.name, slot.key, e.target.value)}
                      >
                        <option value="">—</option>
                        {choices.map((c) => (
                          <option key={c.value} value={c.value}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                      {slot.hint && <span className="hint">{slot.hint}</span>}
                    </label>
                  );
                })}
                {def.fromCompletion && (
                  <p className="hint prof-slot-note">
                    {hasCompletion
                      ? "Completion comes from the status field set under Completion below — one place to change it, not two."
                      : "No status field yet. Add one below and this type will say which values mean finished."}
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
