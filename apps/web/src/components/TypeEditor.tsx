import type { FieldType, PropertySchema } from "@hermes/shared";
import { useState } from "react";
import { api, ApiError, type BlockType } from "../api.ts";
import { BlockIcon, ICON_KEYS } from "../lib/icons.tsx";
import { ColorPickerModal } from "./ColorPickerModal.tsx";

const FIELD_TYPES: FieldType[] = [
  "text",
  "date",
  "datetime",
  "number",
  "boolean",
  "select",
  "status",
  "url",
];

interface EditField {
  key: string;
  label: string;
  type: FieldType;
  includeEmbed: boolean;
  options: string; // comma-separated in the UI
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
      type: f.type,
      includeEmbed: f.includeEmbed,
      options: (f.options ?? []).join(", "),
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
  const [colorOpen, setColorOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="icon-preview">
            <BlockIcon iconKey={iconKey} color={iconColor} size={22} />
          </span>
          <button className="swatch-btn" style={{ background: iconColor }} onClick={() => setColorOpen(true)}>
            color
          </button>
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
        <div className="icon-grid">
          {ICON_KEYS.map((k) => (
            <button
              key={k}
              className={`icon-choice${k === iconKey ? " selected" : ""}`}
              title={k}
              onClick={() => setIconKey(k)}
            >
              <BlockIcon iconKey={k} color={iconColor} size={18} />
            </button>
          ))}
        </div>
      </div>

      <div className="field">
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
                    {t}
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
        <div className="field">
          <span className="field-label">Status / completion</span>
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
          <div className="hint" style={{ marginBottom: 6 }}>
            Values that count as “complete”:
          </div>
          <div className="row" style={{ flexWrap: "wrap", gap: 12, marginBottom: 8 }}>
            {statusOptions.map((o) => (
              <label className="row" style={{ gap: 5 }} key={o}>
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
                <span className="hint">{o}</span>
              </label>
            ))}
          </div>
          <label className="field" style={{ marginBottom: 0 }}>
            <span>Default value</span>
            <select value={defaultValue} onChange={(e) => setDefaultValue(e.target.value)}>
              <option value="">—</option>
              {statusOptions.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </label>
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
    </div>
  );
}
