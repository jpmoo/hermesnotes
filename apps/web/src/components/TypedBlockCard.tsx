import type { FieldDef } from "@hermes/shared";
import { useRef, useState } from "react";
import type { BlockType, Block } from "../api.ts";
import { api, ApiError } from "../api.ts";
import { BlockIcon } from "../lib/icons.tsx";
import { fmtDateTime } from "../lib/format.ts";
import { usePanels } from "../lib/right-panel.tsx";
import { AttachmentsChip } from "./AttachmentsField.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { FieldInput } from "./FieldInput.tsx";
import { MentionTextInput } from "./MentionTextInput.tsx";
import { TagEditor } from "./TagEditor.tsx";

type SaveState = "idle" | "saving" | "error";

/** Icon-as-status control: the block icon reflects status; click cycles to next. */
export function StatusControl({
  field,
  value,
  onChange,
  fallbackIconKey,
  fallbackColor,
}: {
  field: FieldDef;
  value: unknown;
  onChange: (value: string) => void;
  fallbackIconKey: string | null;
  fallbackColor: string | null;
}) {
  const options = field.options ?? [];
  const cur = value == null ? "" : String(value);
  const icons = field.optionIcons ?? {};
  const colors = field.optionColors ?? {};

  const cycle = () => {
    if (!options.length) return;
    const idx = options.indexOf(cur);
    const next = options[(idx + 1) % options.length];
    if (next) onChange(next);
  };

  return (
    <button
      className="status-btn"
      title={cur ? `Status: ${cur.replace(/_/g, " ")} — click to cycle` : "Set status — click to cycle"}
      onClick={cycle}
    >
      <BlockIcon iconKey={icons[cur] ?? fallbackIconKey} color={colors[cur] ?? fallbackColor} size={20} />
    </button>
  );
}

/** Schema-driven editor for a typed block (task/event/custom). */
export function TypedBlockCard({
  block,
  type,
  onConflict,
  onDeleted,
  onChange,
  compact = false,
}: {
  block: Block;
  type: BlockType;
  onConflict: () => void;
  onDeleted: (id: string) => void;
  onChange?: (patch: { properties?: Record<string, unknown>; content?: string | null }) => void;
  compact?: boolean;
}) {
  const [props, setProps] = useState<Record<string, unknown>>(block.properties ?? {});
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(block.updatedAt);
  const versionRef = useRef(block.version);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const { selectBlock } = usePanels();

  const schema = type.propertySchema;
  const fields = [...(schema?.fields ?? [])].sort((a, b) => a.order - b.order);
  const titleField = fields.find((f) => f.key === "title");
  const statusKey = schema?.status_field ?? null;
  const statusField = fields.find((f) => f.type === "status" && f.key === statusKey) ?? null;
  // Status lives in the icon; title lives in the header — the rest go in the body.
  const rest = fields.filter((f) => f.key !== "title" && f.key !== statusKey);
  const hasAttachField = rest.some((f) => f.type === "attachments");
  // In masonry (compact) the attachments field is replaced by a paperclip chip.
  const bodyFields = compact ? rest.filter((f) => f.type !== "attachments") : rest;

  const save = async (next: Record<string, unknown>) => {
    setSaveState("saving");
    try {
      const updated = await api.patch<Block & { recurred?: boolean }>(`/blocks/${block.id}`, {
        properties: next,
        version: versionRef.current,
      });
      versionRef.current = updated.version;
      setUpdatedAt(updated.updatedAt);
      setSaveState("idle");
      // A recurring task just spawned its next occurrence — refresh the list.
      if (updated.recurred) onConflict();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        onConflict();
        return;
      }
      setSaveState("error");
    }
  };

  const update = (key: string, value: unknown) => {
    const next = { ...props, [key]: value };
    setProps(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void save(next);
      onChange?.({ properties: next });
    }, 700);
  };

  const remove = async () => {
    await api.del(`/blocks/${block.id}`);
    onDeleted(block.id);
  };

  return (
    <div className="card typed-card" onPointerDownCapture={() => selectBlock(block.id)}>
      <div className="typed-head">
        {statusField ? (
          <StatusControl
            field={statusField}
            value={props[statusField.key]}
            onChange={(v) => update(statusField.key, v)}
            fallbackIconKey={type.iconKey}
            fallbackColor={type.iconColor}
          />
        ) : (
          type.showIcon && <BlockIcon iconKey={type.iconKey} color={type.iconColor} size={20} />
        )}
        <MentionTextInput
          className="typed-title"
          placeholder={titleField?.label ?? "Title"}
          value={props.title == null ? "" : String(props.title)}
          onChange={(v) => update("title", v)}
        />
      </div>

      {bodyFields.length > 0 && (
        <div className="typed-fields">
          {bodyFields.map((f) => {
            const full =
              f.type === "text" ||
              f.type === "longtext" ||
              f.type === "url" ||
              f.type === "datespan" ||
              f.type === "attachments";
            // A native <label> forwards clicks to its first form control, which
            // hijacks clicks inside rich fields (e.g. a longtext checklist's
            // first checkbox, a date picker's trigger) — use a div for those.
            const simple =
              f.type === "text" ||
              f.type === "number" ||
              f.type === "url" ||
              f.type === "boolean" ||
              f.type === "select" ||
              f.type === "status";
            const Tag = simple ? "label" : "div";
            return (
              <Tag className={`field typed-field${full ? " full" : ""}`} key={f.key}>
                <span>{f.label ?? f.key.replace(/_/g, " ")}</span>
                <FieldInput
                  field={f}
                  value={props[f.key]}
                  onChange={(v) => update(f.key, v)}
                  blockId={block.id}
                />
              </Tag>
            );
          })}
        </div>
      )}

      {compact && hasAttachField ? (
        <div className="tags-line">
          <AttachmentsChip blockId={block.id} />
          <TagEditor blockId={block.id} />
        </div>
      ) : (
        <TagEditor blockId={block.id} />
      )}

      <div className="block-meta">
        <span className="meta-dates">
          Created {fmtDateTime(block.createdAt)} · Edited {fmtDateTime(updatedAt)}
        </span>
        {saveState === "saving" && <span>saving…</span>}
        {saveState === "error" && <span className="error">save failed</span>}
        <span style={{ flex: 1 }} />
        <button className="ghost" onClick={() => setConfirmOpen(true)}>
          Delete
        </button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title={`Delete this ${type.name}?`}
        message="This permanently removes the block and its embedding. This can't be undone."
        confirmLabel="Delete"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          void remove();
        }}
      />
    </div>
  );
}
