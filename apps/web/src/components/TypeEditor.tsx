import type { FieldType, PropertySchema } from "@hermes/shared";
import { useEffect, useState } from "react";
import { api, ApiError, type BlockType } from "../api.ts";
import { BlockIcon } from "../lib/icons.tsx";
import { ColorPickerModal } from "./ColorPickerModal.tsx";
import { IconPickerModal } from "./IconPickerModal.tsx";

const FIELD_TYPES: FieldType[] = [
  "text",
  "datetime",
  "datespan",
  "number",
  "boolean",
  "select",
  "status",
  "url",
  "reference",
];

const TYPE_LABELS: Partial<Record<FieldType, string>> = {
  datetime: "Date/Time",
  datespan: "Date/Time Span",
};

interface EditField {
  key: string;
  label: string;
  type: FieldType;
  includeEmbed: boolean;
  options: string; // comma-separated in the UI
  refTypeId?: string; // for reference fields
  startLabel?: string; // for datespan
  endLabel?: string; // for datespan
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
      options: (f.options ?? []).join(", "),
      refTypeId: f.refTypeId,
      startLabel: f.startLabel,
      endLabel: f.endLabel,
    }));
}

const parseOptions = (s: string) =>
  s
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

export function TypeEditor({
  initial,
  onSaved,
  onCancel,
}: {
  initial: BlockType | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.get<BlockType[]>("/block-types").then(setBlockTypes);
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

  const save = async () => {
    setError(null);
    if (!name.trim()) return setError("Name is required");
    if (!fields.some((f) => f.key === "title")) return setError("A 'title' field is required");
    if (fields.some((f) => !f.key.trim())) return setError("Every field needs a key");

    const schema: PropertySchema = {
      fields: fields.map((f, i) => ({
        key: f.key.trim(),
        label: f.label.trim() || undefined,
        type: f.type,
        order: i,
        includeEmbed: f.includeEmbed,
        options:
          f.type === "select" || f.type === "status" ? parseOptions(f.options) : undefined,
        optionIcons:
          activeStatus && f.key === activeStatus.key && Object.keys(optIcons).length
            ? optIcons
            : undefined,
        optionColors:
          activeStatus && f.key === activeStatus.key && Object.keys(optColors).length
            ? optColors
            : undefined,
        refTypeId: f.type === "reference" ? f.refTypeId : undefined,
        startLabel: f.type === "datespan" ? f.startLabel?.trim() || undefined : undefined,
        endLabel: f.type === "datespan" ? f.endLabel?.trim() || undefined : undefined,
      })),
      status_field: activeStatus ? activeStatus.key : null,
      complete_values: activeStatus ? completeValues : undefined,
      default_value: activeStatus ? defaultValue || null : null,
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
                onChange={(e) => setField(i, { type: e.target.value as FieldType })}
              >
                {FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABELS[t] ?? t}
                  </option>
                ))}
              </select>
              {(f.type === "select" || f.type === "status") && (
                <input
                  className="f-options"
                  placeholder="option1, option2"
                  value={f.options}
                  onChange={(e) => setField(i, { options: e.target.value })}
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
              <label className="row" style={{ gap: 4 }} title="Include in embedding">
                <input
                  type="checkbox"
                  checked={f.includeEmbed}
                  onChange={(e) => setField(i, { includeEmbed: e.target.checked })}
                  style={{ width: "auto" }}
                />
                <span className="hint">embed</span>
              </label>
              <button className="icon-btn" title="Move up" onClick={() => move(i, -1)}>
                ↑
              </button>
              <button className="icon-btn" title="Move down" onClick={() => move(i, 1)}>
                ↓
              </button>
              <button
                className="icon-btn"
                title="Remove"
                disabled={f.key === "title"}
                onClick={() => removeField(i)}
              >
                ✕
              </button>
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
      <div className="modal-actions" style={{ marginTop: 8 }}>
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

