import { useRef, useState } from "react";
import type { BlockType, Block } from "../api.ts";
import { api, ApiError } from "../api.ts";
import { BlockIcon } from "../lib/icons.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { FieldInput } from "./FieldInput.tsx";

type SaveState = "idle" | "saving" | "error";

/** Schema-driven editor for a typed block (task/event/custom). */
export function TypedBlockCard({
  block,
  type,
  onConflict,
  onDeleted,
}: {
  block: Block;
  type: BlockType;
  onConflict: () => void;
  onDeleted: (id: string) => void;
}) {
  const [props, setProps] = useState<Record<string, unknown>>(block.properties ?? {});
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const versionRef = useRef(block.version);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const fields = [...(type.propertySchema?.fields ?? [])].sort((a, b) => a.order - b.order);
  const titleField = fields.find((f) => f.key === "title");
  const rest = fields.filter((f) => f.key !== "title");

  const save = async (next: Record<string, unknown>) => {
    setSaveState("saving");
    try {
      const updated = await api.patch<Block>(`/blocks/${block.id}`, {
        properties: next,
        version: versionRef.current,
      });
      versionRef.current = updated.version;
      setSaveState("idle");
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
    timer.current = setTimeout(() => void save(next), 700);
  };

  const remove = async () => {
    await api.del(`/blocks/${block.id}`);
    onDeleted(block.id);
  };

  return (
    <div className="card typed-card">
      <div className="typed-head">
        {type.showIcon && <BlockIcon iconKey={type.iconKey} color={type.iconColor} size={20} />}
        <input
          className="typed-title"
          placeholder={titleField?.label ?? "Title"}
          value={props.title == null ? "" : String(props.title)}
          onChange={(e) => update("title", e.target.value)}
        />
      </div>

      {rest.length > 0 && (
        <div className="typed-fields">
          {rest.map((f) => (
            <label className="field typed-field" key={f.key}>
              <span>{f.label ?? f.key.replace(/_/g, " ")}</span>
              <FieldInput field={f} value={props[f.key]} onChange={(v) => update(f.key, v)} />
            </label>
          ))}
        </div>
      )}

      <div className="block-meta">
        <span className="type-name">{type.name}</span>
        <span>
          {saveState === "saving" ? "saving…" : saveState === "error" ? "save failed" : "saved"}
        </span>
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
