import { templateName, type FieldType, type PropertySchema } from "@hermes/shared";
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
  // Carried, not edited. Nothing here asks what a type is — the question is
  // about interoperability with tools the reader may never touch, and the two
  // profiles that cannot be worked out from the schema are the two nothing in
  // Hermes reads yet. But a type that has declared one, by hand or by some
  // later surface, must not lose it for having been opened in this form.
  const profiles = (initial?.propertySchema?.profiles ?? {}) as Record<string, Record<string, unknown>>;
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
              name === "task" && activeStatus
                ? { ...map, status: activeStatus.key, completeValues }
                : map,
            ]),
          )
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

