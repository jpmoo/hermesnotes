import { profilesOf, templateName, type FieldType, type PropertySchema } from "@hermes/shared";
import { useEffect, useState } from "react";
import { api, ApiError, type Block, type BlockType } from "../api.ts";
import { useAiConfig } from "../lib/ai-config.tsx";
import { BlockIcon } from "../lib/icons.tsx";
import { ColorPickerModal } from "./ColorPickerModal.tsx";
import { IconPickerModal } from "./IconPickerModal.tsx";

const FIELD_TYPES: FieldType[] = [
  "text",
  "longtext",
  "datetime",
  "datespan",
  "number",
  "boolean",
  "select",
  "status",
  "url",
  "reference",
  "attachments",
];

const TYPE_LABELS: Record<FieldType, string> = {
  text: "Text",
  longtext: "Long Text",
  date: "Date",
  datetime: "Date/Time",
  datespan: "Date/Time Span",
  number: "Number",
  boolean: "Boolean",
  select: "Select",
  status: "Status",
  url: "URL",
  reference: "Reference",
  attachments: "File Attachments",
  recurrence: "Recurrence",
};

interface EditField {
  key: string;
  label: string;
  type: FieldType;
  includeEmbed: boolean;
  options: string; // comma-separated in the UI
  refTypeId?: string; // for reference fields
  templateId?: string | null; // longtext: the template a new block starts from
  startLabel?: string; // for datespan
  endLabel?: string; // for datespan
  units?: string; // for number
  locked?: boolean; // built-in core field: editable but not removable
}

function toEditFields(schema: PropertySchema | null): EditField[] {
  if (!schema) {
    return [{ key: "title", label: "Title", type: "text", includeEmbed: true, options: "" }];
  }
  return [...schema.fields]
    .sort((a, b) => a.order - b.order)
    .map((f) => ({
      key: f.key,
      label: f.label ?? "",
      // legacy date-only fields become Date/Time.
      type: f.type === "date" ? "datetime" : f.type,
      includeEmbed: f.includeEmbed,
      options: formatOptionSpec(f.options, f.optionLabels),
      refTypeId: f.refTypeId,
      templateId: f.templateId ?? null,
      startLabel: f.startLabel,
      endLabel: f.endLabel,
      units: f.units,
      locked: f.locked,
    }));
}

/**
 * Options are written as a comma-separated list, where an entry may name the
 * stored value separately from what the reader sees:
 *
 *     Not started = todo, In progress = doing, Done
 *
 * The part before `=` is the label, the part after is the value stored on the
 * block; with no `=`, the two are the same. Splitting them matters when the label
 * should change without rewriting every block that already holds the old value.
 */
function parseOptionSpec(s: string): { values: string[]; labels: Record<string, string> } {
  const values: string[] = [];
  const labels: Record<string, string> = {};
  for (const entry of s.split(",")) {
    const [rawLabel, ...rest] = entry.split("=");
    const label = (rawLabel ?? "").trim();
    const value = rest.join("=").trim() || label;
    if (!value) continue;
    if (values.includes(value)) continue; // a value can only mean one thing
    values.push(value);
    if (label && label !== value) labels[value] = label;
  }
  return { values, labels };
}

/** Turn stored options back into the editable "Label = value" list. */
function formatOptionSpec(values: string[] | undefined, labels: Record<string, string> | undefined) {
  return (values ?? [])
    .map((v) => {
      const label = labels?.[v];
      return label && label !== v ? `${label} = ${v}` : v;
    })
    .join(", ");
}

const parseOptions = (s: string) => parseOptionSpec(s).values;

/*
 * What a type is, said to other apps (pkm-interchange, *Profiles*): which of
 * its fields is a person's email, a meeting's start, a task's project. Hermes
 * reads none of these itself — a sync reads them, and Talaris, and any tool
 * that has never heard of Hermes. Nothing is guessed: a slot is set by hand
 * or not at all, and one left empty says this type has no such thing.
 *
 * A slot names a field, or half of a date span. The slots that point at other
 * things — a meeting's people, a task's project — take only reference fields.
 */
type SlotKind = "words" | "when" | "ref" | "wordsOrRef" | "body";
const PROFILE_SLOTS: Record<string, { label: string; slots: [string, string, SlotKind][] }> = {
  contact: { label: "A person", slots: [["title", "Name", "words"], ["email", "Email", "words"], ["phone", "Phone", "words"], ["organization", "Organization", "wordsOrRef"], ["role", "Role", "words"], ["body", "About", "body"]] },
  event: { label: "An event", slots: [["title", "Title", "words"], ["start", "Starts", "when"], ["end", "Ends", "when"], ["location", "Where", "words"], ["attendees", "Who is invited", "ref"], ["organizer", "Organizer", "ref"], ["body", "Description", "body"]] },
  project: { label: "A project", slots: [["title", "Name", "words"], ["body", "Description", "body"]] },
  // A note, and the project it belongs to (pkm-interchange: note.project), as a task's.
  note: { label: "A note", slots: [["title", "Title", "words"], ["body", "Body", "body"], ["project", "Project", "ref"]] },
};
const fitsSlot = (f: EditField, kind: SlotKind) =>
  kind === "ref" ? f.type === "reference"
  : kind === "wordsOrRef" ? f.type === "text" || f.type === "url" || f.type === "reference"
  : kind === "body" ? f.type === "longtext" || f.type === "text"
  : kind === "when" ? f.type === "datetime" || f.type === "date" || f.type === "datespan"
  : f.type === "text" || f.type === "url" || f.type === "select";
/** A slot's choices: each field that fits, and each half of a date span. */
function slotChoices(fields: EditField[], kind: SlotKind): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  for (const f of fields) {
    if (!f.key.trim() || !fitsSlot(f, kind)) continue;
    const name = f.label.trim() || f.key;
    if (kind === "when" && f.type === "datespan") {
      out.push({ value: JSON.stringify({ field: f.key, part: "start" }), label: `${name} — ${f.startLabel || "start"}` });
      out.push({ value: JSON.stringify({ field: f.key, part: "end" }), label: `${name} — ${f.endLabel || "end"}` });
    } else out.push({ value: f.key, label: name });
  }
  // A body may also be the block's own text, the format's reserved `content` — where a text type's notes keep their
  // words. Not offered, a profile declaring it showed the first field instead, and saved the type with that: a
  // note's words read from an empty field, and a sync saw every note emptied.
  if (kind === "body") out.unshift({ value: "content", label: "Its own words" });
  return out;
}
const slotValue = (spec: unknown) => (spec === undefined || spec === null ? "" : typeof spec === "string" ? spec : JSON.stringify(spec));
const slotSpec = (value: string): unknown => (value.startsWith("{") ? JSON.parse(value) : value);

export function TypeEditor({
  initial,
  onSaved,
  onCancel,
}: {
  initial: BlockType | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { embed: embedEnabled } = useAiConfig();
  const [name, setName] = useState(initial?.name ?? "");
  const [iconKey, setIconKey] = useState(initial?.iconKey ?? "file-text");
  const [iconColor, setIconColor] = useState(initial?.iconColor ?? "#5fa4b5");
  const [showIcon, setShowIcon] = useState(initial?.showIcon ?? true);
  const [fields, setFields] = useState<EditField[]>(toEditFields(initial?.propertySchema ?? null));
  const [statusField, setStatusField] = useState(initial?.propertySchema?.status_field ?? "");
  const [completeValues, setCompleteValues] = useState<string[]>(
    initial?.propertySchema?.complete_values ?? [],
  );
  const [defaultValue, setDefaultValue] = useState(initial?.propertySchema?.default_value ?? "");
  // What each status means to other apps (pkm-interchange: the task profile's `states`) — chosen beside
  // each option, only among the states its "complete" box allows, so the two can never disagree.
  const [states, setStates] = useState<Record<string, string>>(
    ((initial?.propertySchema?.profiles as Record<string, { states?: Record<string, string> }> | undefined)?.task?.states ?? {}) as Record<string, string>,
  );
  // What it is to other apps: edited below ("What this is, to other apps"),
  // and anything declared that this form has no words for is carried whole.
  const [profiles, setProfiles] = useState<Record<string, Record<string, unknown>>>(
    (initial?.propertySchema?.profiles ?? {}) as Record<string, Record<string, unknown>>,
  );
  const initialStatus = initial?.propertySchema?.fields.find(
    (f) => f.type === "status" && f.key === initial?.propertySchema?.status_field,
  );
  const [optIcons, setOptIcons] = useState<Record<string, string>>(
    initialStatus?.optionIcons ?? {},
  );
  const [optColors, setOptColors] = useState<Record<string, string>>(
    initialStatus?.optionColors ?? {},
  );
  const [iconPickTarget, setIconPickTarget] = useState<string | null>(null);
  const [colorPickTarget, setColorPickTarget] = useState<string | null>(null);
  const [colorOpen, setColorOpen] = useState(false);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [blockTypes, setBlockTypes] = useState<BlockType[]>([]);
  // Offered on long-text fields: what a new block of this type starts with.
  const [templates, setTemplates] = useState<Block[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.get<BlockType[]>("/block-types").then(setBlockTypes);
    void api.get<Block[]>("/templates").then(setTemplates).catch(() => {});
  }, []);

  const statusFields = fields.filter((f) => f.type === "status");
  const activeStatus = statusFields.find((f) => f.key === statusField) ?? statusFields[0];
  const statusOptions = activeStatus ? parseOptions(activeStatus.options) : [];

  const setField = (i: number, patch: Partial<EditField>) =>
    setFields((prev) => prev.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  const addField = () =>
    setFields((prev) => [
      ...prev,
      { key: "", label: "", type: "text", includeEmbed: false, options: "" },
    ]);
  const removeField = (i: number) => setFields((prev) => prev.filter((_, idx) => idx !== i));
  const move = (i: number, dir: -1 | 1) =>
    setFields((prev) => {
      const next = [...prev];
      const j = i + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  const isText = initial?.isText ?? false;

  /** The task profile the status field implies, as Hermes has always worked it out. */
  /** The meanings given, for the options there are now, each still fitting its "complete" box: `{ states }`, or nothing. */
  const statesNow = (): { states?: Record<string, string> } => {
    const kept = Object.fromEntries(statusOptions.filter((o) => STATE_FITS(completeValues.includes(o)).some(([v]) => v === states[o])).map((o) => [o, states[o]!]));
    return Object.keys(kept).length ? { states: kept } : {};
  };
  const derivedTask = (): Record<string, unknown> => {
    const bare = {
      fields: fields.map((f, i) => ({ key: f.key.trim(), type: f.type, order: i, includeEmbed: f.includeEmbed })),
      status_field: activeStatus?.key ?? null,
      complete_values: completeValues,
    } as unknown as PropertySchema;
    return profilesOf(bare).find((p) => p.name === "task")?.map ?? {};
  };

  const save = async () => {
    setError(null);
    if (!name.trim()) return setError("Name is required");
    if (!isText && !fields.some((f) => f.key === "title"))
      return setError("A 'title' field is required");
    if (fields.some((f) => !f.key.trim())) return setError("Every field needs a key");

    const schema: PropertySchema = {
      fields: fields.map((f, i) => ({
        key: f.key.trim(),
        label: f.label.trim() || undefined,
        type: f.type,
        order: i,
        includeEmbed: f.includeEmbed,
        options:
          f.type === "select" || f.type === "status" ? parseOptionSpec(f.options).values : undefined,
        optionLabels:
          f.type === "select" || f.type === "status"
            ? (() => {
                const labels = parseOptionSpec(f.options).labels;
                return Object.keys(labels).length ? labels : undefined;
              })()
            : undefined,
        optionIcons:
          activeStatus && f.key === activeStatus.key && Object.keys(optIcons).length
            ? optIcons
            : undefined,
        optionColors:
          activeStatus && f.key === activeStatus.key && Object.keys(optColors).length
            ? optColors
            : undefined,
        refTypeId: f.type === "reference" ? f.refTypeId : undefined,
        templateId: f.type === "longtext" ? f.templateId || null : undefined,
        units: f.type === "number" ? f.units?.trim() || undefined : undefined,
        startLabel: f.type === "datespan" ? f.startLabel?.trim() || undefined : undefined,
        endLabel: f.type === "datespan" ? f.endLabel?.trim() || undefined : undefined,
        locked: f.locked || undefined,
      })),
      status_field: activeStatus ? activeStatus.key : null,
      complete_values: activeStatus ? completeValues : undefined,
      default_value: activeStatus ? defaultValue || null : null,
      // A declared task profile keeps its completion slots in step with the
      // status field set below: two places to say the same thing is two places
      // to disagree.
      profiles: Object.keys(profiles).length
        ? Object.fromEntries(
            Object.entries(profiles).map(([name, map]) => [
              name,
              // A declared task profile is the one Hermes works out from the
              // status field, whole, with what was set here (its project) on
              // top — declaring it must not cost it its title or its dates.
              name === "task" && activeStatus
                ? { ...derivedTask(), ...map, status: activeStatus.key, completeValues, ...statesNow() }
                : map,
            ]),
          )
        : statesNow().states && activeStatus
          // Meanings given and the task profile not otherwise declared: declared now, to carry them.
          ? { task: { ...derivedTask(), status: activeStatus.key, completeValues, ...statesNow() } }
          : undefined,
    };

    setBusy(true);
    try {
      const payload = { name: name.trim(), iconKey, iconColor, showIcon, propertySchema: schema };
      if (initial) await api.patch(`/block-types/${initial.id}`, payload);
      else await api.post("/block-types", payload);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not save type");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card type-editor">
      <h2 className="chrome" style={{ marginTop: 0 }}>
        {initial ? `Edit “${initial.name}”` : "New block type"}
      </h2>

      <label className="field">
        <span>Name</span>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </label>

      <div className="field">
        <span className="field-label">Icon</span>
        <div className="row">
          <button
            className="icon-preview icon-preview-btn"
            title="Choose icon"
            onClick={() => setIconPickerOpen(true)}
          >
            <BlockIcon iconKey={iconKey} color={iconColor} size={22} />
          </button>
          <button
            className="swatch-btn"
            title="Icon color"
            style={{ background: iconColor }}
            onClick={() => setColorOpen(true)}
          />
          <label className="row" style={{ gap: 6 }}>
            <input
              type="checkbox"
              checked={showIcon}
              onChange={(e) => setShowIcon(e.target.checked)}
              style={{ width: "auto" }}
            />
            <span className="hint">Show icon</span>
          </label>
        </div>
      </div>

      <div className="field" style={{ marginTop: 18 }}>
        <span className="field-label">Fields</span>
        <div className="fields-table">
          {fields.map((f, i) => (
            <div className="field-row" key={i}>
              <input
                className="f-key"
                placeholder="key"
                value={f.key}
                disabled={f.locked}
                title={f.locked ? "Built-in field — key is fixed" : undefined}
                onChange={(e) => setField(i, { key: e.target.value })}
              />
              <input
                className="f-label"
                placeholder="label"
                value={f.label}
                onChange={(e) => setField(i, { label: e.target.value })}
              />
              <select
                className="f-type"
                value={f.type}
                disabled={f.locked}
                title={f.locked ? "Built-in field — type is fixed" : undefined}
                onChange={(e) => setField(i, { type: e.target.value as FieldType })}
              >
                {(FIELD_TYPES.includes(f.type) ? FIELD_TYPES : [f.type, ...FIELD_TYPES]).map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABELS[t] ?? t}
                  </option>
                ))}
              </select>
              {(f.type === "select" || f.type === "status") && (
                <input
                  className="f-options"
                  placeholder="Option one, Shown label = stored_value"
                  title={"Comma-separated. Write \"Label = value\" to show one thing and store another; with no \"=\", the option is its own label."}
                  value={f.options}
                  onChange={(e) => setField(i, { options: e.target.value })}
                />
              )}
              {f.type === "number" && (
                <input
                  className="f-options"
                  placeholder="units (optional), e.g. minutes"
                  title={'Shown after the number, e.g. "30 minutes".'}
                  value={f.units ?? ""}
                  onChange={(e) => setField(i, { units: e.target.value })}
                />
              )}
              {f.type === "datespan" && (
                <>
                  <input
                    className="f-options"
                    placeholder="start label (e.g. Available)"
                    value={f.startLabel ?? ""}
                    onChange={(e) => setField(i, { startLabel: e.target.value })}
                  />
                  <input
                    className="f-options"
                    placeholder="end label (e.g. Due)"
                    value={f.endLabel ?? ""}
                    onChange={(e) => setField(i, { endLabel: e.target.value })}
                  />
                </>
              )}
              {f.type === "longtext" && (
                <select
                  className="f-options"
                  title="A new block of this type starts this field from…"
                  value={f.templateId ?? ""}
                  onChange={(e) => setField(i, { templateId: e.target.value || null })}
                >
                  <option value="">no template</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {templateName(t.properties) || "Untitled"}
                    </option>
                  ))}
                </select>
              )}
              {f.type === "reference" && (
                <select
                  className="f-options"
                  value={f.refTypeId ?? ""}
                  onChange={(e) => setField(i, { refTypeId: e.target.value || undefined })}
                >
                  <option value="">target type…</option>
                  {blockTypes
                    .filter((bt) => !bt.isText)
                    .map((bt) => (
                      <option key={bt.id} value={bt.id}>
                        {bt.name}
                      </option>
                    ))}
                </select>
              )}
              {embedEnabled && (
                <label className="row" style={{ gap: 4 }} title="Include in embedding">
                  <input
                    type="checkbox"
                    checked={f.includeEmbed}
                    onChange={(e) => setField(i, { includeEmbed: e.target.checked })}
                    style={{ width: "auto" }}
                  />
                  <span className="hint">embed</span>
                </label>
              )}
              <button className="icon-btn" title="Move up" onClick={() => move(i, -1)}>
                ↑
              </button>
              <button className="icon-btn" title="Move down" onClick={() => move(i, 1)}>
                ↓
              </button>
              {!(f.key === "title" || f.locked) && (
                <button className="icon-btn" title="Remove" onClick={() => removeField(i)}>
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
        <button className="ghost" onClick={addField} style={{ marginTop: 8 }}>
          + Add field
        </button>
      </div>

      {activeStatus && (
        <div className="field" style={{ marginTop: 18 }}>
          <span className="field-label">Status options — icon, color, completion, default</span>
          {statusFields.length > 1 && (
            <select
              value={statusField || activeStatus.key}
              onChange={(e) => setStatusField(e.target.value)}
              style={{ marginBottom: 8 }}
            >
              {statusFields.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.key}
                </option>
              ))}
            </select>
          )}
          {statusOptions.length === 0 ? (
            <div className="hint">Add comma-separated options to the status field above.</div>
          ) : (
            <div className="status-opts">
              {statusOptions.map((o) => (
                <div className="status-opt-row" key={o}>
                  <button className="icon-choice" title="Icon" onClick={() => setIconPickTarget(o)}>
                    <BlockIcon iconKey={optIcons[o]} color={optColors[o]} size={18} />
                  </button>
                  <button
                    className="swatch-btn small"
                    title="Color"
                    style={{ background: optColors[o] ?? "#9aa0a6" }}
                    onClick={() => setColorPickTarget(o)}
                  />
                  <span className="status-opt-name">{o.replace(/_/g, " ")}</span>
                  <label className="row" style={{ gap: 5 }}>
                    <input
                      type="checkbox"
                      checked={completeValues.includes(o)}
                      onChange={(e) =>
                        setCompleteValues((prev) =>
                          e.target.checked ? [...prev, o] : prev.filter((v) => v !== o),
                        )
                      }
                      style={{ width: "auto" }}
                    />
                    <span className="hint">complete</span>
                  </label>
                  <select
                    className="f-type status-state"
                    title="What this status means to other apps — so a sync can carry it"
                    value={STATE_FITS(completeValues.includes(o)).some(([v]) => v === states[o]) ? states[o] : ""}
                    onChange={(e) => setStates((prev) => {
                      const next = { ...prev };
                      if (e.target.value) next[o] = e.target.value;
                      else delete next[o];
                      return next;
                    })}
                  >
                    <option value="">means… (not said)</option>
                    {STATE_FITS(completeValues.includes(o)).map(([v, label]) => (
                      <option key={v} value={v}>{label}</option>
                    ))}
                  </select>
                  <label className="row" style={{ gap: 5 }}>
                    <input
                      type="radio"
                      name="status-default"
                      checked={defaultValue === o}
                      onChange={() => setDefaultValue(o)}
                      style={{ width: "auto" }}
                    />
                    <span className="hint">default</span>
                  </label>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <ProfilesSection fields={fields} profiles={profiles} setProfiles={setProfiles} isTask={Boolean(activeStatus)} derivedTask={derivedTask} statusName={activeStatus ? activeStatus.label.trim() || activeStatus.key : ""} />

      {error && <div className="error">{error}</div>}
      <div className="type-actions">
        <button className="ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="primary" onClick={() => void save()} disabled={busy}>
          {busy ? "Saving…" : "Save type"}
        </button>
      </div>

      <ColorPickerModal
        open={colorOpen}
        title="Icon color"
        value={iconColor}
        onCancel={() => setColorOpen(false)}
        onSave={(c) => {
          setIconColor(c);
          setColorOpen(false);
        }}
      />

      <IconPickerModal
        open={iconPickerOpen}
        value={iconKey}
        color={iconColor}
        onCancel={() => setIconPickerOpen(false)}
        onSelect={(k) => {
          setIconKey(k);
          setIconPickerOpen(false);
        }}
      />

      {/* Per-status-option icon + color */}
      <IconPickerModal
        open={iconPickTarget !== null}
        value={iconPickTarget ? optIcons[iconPickTarget] ?? null : null}
        color={iconPickTarget ? optColors[iconPickTarget] : undefined}
        onCancel={() => setIconPickTarget(null)}
        onSelect={(k) => {
          if (iconPickTarget) setOptIcons((prev) => ({ ...prev, [iconPickTarget]: k }));
          setIconPickTarget(null);
        }}
      />
      <ColorPickerModal
        open={colorPickTarget !== null}
        title="Status color"
        value={colorPickTarget ? optColors[colorPickTarget] ?? "#5fa4b5" : "#5fa4b5"}
        onCancel={() => setColorPickTarget(null)}
        onSave={(c) => {
          if (colorPickTarget) setOptColors((prev) => ({ ...prev, [colorPickTarget]: c }));
          setColorPickTarget(null);
        }}
      />
    </div>
  );
}


/*
 * "What this is, to other apps": a task, a person, an event, a project — any
 * of them, each with its slots matched to this type's fields.
 *
 * A task is not ticked here: a type *is* one when it has a status field whose
 * completion is set (below, Status options) — what Hermes has always gone by.
 * It is shown all the same, ticked or not, with the slots it fills, so the
 * section never reads as though tasks were the one thing that cannot be said;
 * its start, due date and project can be matched to other fields here.
 */
/** The states a status may mean, by whether it completes a task: finished ones end it, the rest do not. */
const STATE_FITS = (complete: boolean): [string, string][] =>
  complete ? [["done", "Done"], ["cancelled", "Cancelled"]] : [["not-started", "Not started"], ["in-progress", "In progress"], ["waiting", "Waiting"]];

const TASK_SLOTS: [string, string, SlotKind][] = [["title", "Name", "words"], ["start", "Available", "when"], ["due", "Due", "when"], ["project", "Project", "ref"], ["body", "Notes", "body"]];

function ProfilesSection({
  fields,
  profiles,
  setProfiles,
  isTask,
  derivedTask,
  statusName,
}: {
  fields: EditField[];
  profiles: Record<string, Record<string, unknown>>;
  setProfiles: (next: Record<string, Record<string, unknown>>) => void;
  isTask: boolean;
  derivedTask: () => Record<string, unknown>;
  statusName: string;
}) {
  const setSlot = (profile: string, slot: string, value: string) => {
    const map = { ...(profiles[profile] ?? {}) };
    if (value) map[slot] = slotSpec(value);
    else delete map[slot];
    setProfiles({ ...profiles, [profile]: map });
  };
  const toggle = (profile: string, on: boolean) => {
    const next = { ...profiles };
    if (on) {
      // Its name, to start: the title field is the name of anything.
      next[profile] = fields.some((f) => f.key === "title") ? { title: "title" } : {};
    } else delete next[profile];
    setProfiles(next);
  };
  // A task's slots: what was set here, else what the status field implies.
  // Set here, it is declared — with the rest worked out underneath on save.
  const derived = isTask ? derivedTask() : {};
  const taskSlot = (slot: string) => profiles.task?.[slot] ?? derived[slot];
  const setTaskSlot = (slot: string, value: string) => {
    const next = { ...profiles };
    const task = { ...(next.task ?? {}) } as Record<string, unknown>;
    if (value) task[slot] = slotSpec(value);
    else if (slot in derived) task[slot] = null; // none, said: not the one the status field implied
    else delete task[slot];
    // What matches what would be worked out anyway need not be said.
    if (JSON.stringify(task[slot]) === JSON.stringify(derived[slot])) delete task[slot];
    if (Object.keys(task).length) next.task = task;
    else delete next.task;
    setProfiles(next);
  };
  return (
    <div className="field" style={{ marginTop: 18 }}>
      <span className="field-label">What this is, to other apps</span>
      <div className="hint" style={{ marginBottom: 6 }}>
        So a sync, Talaris, or any app reading the interchange format knows which field is the email, the start, the project. Hermes itself needs none of it.
      </div>
      <div className="row" style={{ gap: 14, flexWrap: "wrap" }}>
        <label className="row" style={{ gap: 6 }} title={isTask ? `Because ${statusName} is a status with completion` : "A type with a Status field whose completion is set is a task"}>
          <input type="checkbox" checked={isTask} disabled style={{ width: "auto" }} />
          <span>A task</span>
        </label>
        {Object.entries(PROFILE_SLOTS).map(([name, def]) => (
          <label className="row" style={{ gap: 6 }} key={name}>
            <input type="checkbox" checked={name in profiles} onChange={(e) => toggle(name, e.target.checked)} style={{ width: "auto" }} />
            <span>{def.label}</span>
          </label>
        ))}
      </div>
      {Object.entries(PROFILE_SLOTS).filter(([name]) => name in profiles).map(([name, def]) => (
        <div className="fields-table" key={name} style={{ marginTop: 8 }}>
          <div className="hint" style={{ margin: "4px 0" }}>{def.label}</div>
          {def.slots.map(([slot, label, kind]) => {
            const choices = slotChoices(fields, kind);
            return (
              <div className="field-row" key={slot}>
                <span className="f-label" style={{ minWidth: 130 }}>{label}</span>
                <select className="f-type" value={slotValue(profiles[name]?.[slot])} onChange={(e) => setSlot(name, slot, e.target.value)}>
                  <option value="">{choices.length ? "— none —" : kind === "ref" ? "— no reference fields —" : "— no fitting field —"}</option>
                  {choices.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      ))}
      {isTask ? (
        <div className="fields-table" style={{ marginTop: 8 }}>
          <div className="hint" style={{ margin: "4px 0" }}>A task — because {statusName} is a status with completion (set under Status options)</div>
          {TASK_SLOTS.map(([slot, label, kind]) => {
            const choices = slotChoices(fields, kind);
            return (
              <div className="field-row" key={slot}>
                <span className="f-label" style={{ minWidth: 130 }}>{label}</span>
                <select className="f-type" value={slotValue(taskSlot(slot))} onChange={(e) => setTaskSlot(slot, e.target.value)}>
                  <option value="">{choices.length ? "— none —" : kind === "ref" ? "— no reference fields —" : "— no fitting field —"}</option>
                  {choices.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="hint" style={{ marginTop: 6 }}>Not a task: a type is one when it has a Status field and its completion is set.</div>
      )}
    </div>
  );
}
