import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Block, type BlockType } from "../api.ts";
import { emitBlockChange, emitBlockDeleted, useBlockOrigin, useBlockSync } from "../lib/block-events.ts";
import { oneLineText } from "../lib/display.ts";
import { fmtDateTime } from "../lib/format.ts";
import { BlockIcon } from "../lib/icons.tsx";
import { usePanels } from "../lib/right-panel.tsx";
import { AttachmentsChip } from "./AttachmentsField.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { FieldInput } from "./FieldInput.tsx";
import { Banner, BannerAddButton, type BannerValue } from "./Banner.tsx";
import { MarkdownEditor } from "./MarkdownEditor.tsx";
import { TagEditor } from "./TagEditor.tsx";

type SaveState = "idle" | "saving" | "error";

/**
 * Text block editor. The body is a shared markdown surface (live/raw, links,
 * @/#/| mentions). Any additional schema fields render below it. Autosaves
 * (debounced) with optimistic-concurrency handling.
 */
export function TextBlockEditor({
  block,
  type,
  onConflict,
  onDeleted,
  onChange,
  canDelete = true,
  compact = false,
  hideBanner = false,
}: {
  block: Block;
  type?: BlockType;
  onConflict: () => void;
  onDeleted: (id: string) => void;
  onChange?: (patch: { properties?: Record<string, unknown>; content?: string | null }) => void;
  canDelete?: boolean;
  compact?: boolean;
  /** Suppress banner UI entirely (e.g. the Today scratchpad). */
  hideBanner?: boolean;
}) {
  const [props, setProps] = useState<Record<string, unknown>>(block.properties ?? {});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [tagsRefresh, setTagsRefresh] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [updatedAt, setUpdatedAt] = useState(block.updatedAt);
  const versionRef = useRef(block.version);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const propsTimer = useRef<ReturnType<typeof setTimeout>>();
  const { selectBlock } = usePanels();

  // Cross-surface sync. The markdown editor owns its content, so foreign
  // updates remount it (keyed) with the fresh text.
  const origin = useBlockOrigin();
  const [ext, setExt] = useState<{ content: string; nonce: number }>({
    content: block.content ?? "",
    nonce: 0,
  });
  useBlockSync(block.id, origin, (b) => {
    setProps(b.properties ?? {});
    versionRef.current = b.version;
    setUpdatedAt(b.updatedAt);
    setExt((e) => ({ content: b.content ?? "", nonce: e.nonce + 1 }));
  });

  // The body IS the "description" field; any other schema fields render below it.
  const extraFields = [...(type?.propertySchema?.fields ?? [])]
    .filter((f) => f.key !== "description")
    .sort((a, b) => a.order - b.order);
  const hasAttachField = extraFields.some((f) => f.type === "attachments");
  const bodyFields = compact ? extraFields.filter((f) => f.type !== "attachments") : extraFields;

  const patch = async (body: Record<string, unknown>) => {
    setSaveState("saving");
    try {
      const updated = await api.patch<Block & { tagsChanged?: boolean }>(`/blocks/${block.id}`, {
        ...body,
        version: versionRef.current,
      });
      versionRef.current = updated.version;
      setUpdatedAt(updated.updatedAt);
      setSaveState("idle");
      emitBlockChange(block.id, origin);
      // #tag mentions were synced to the block's tags — refresh the chips.
      if (updated.tagsChanged) setTagsRefresh((k) => k + 1);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) return onConflict();
      setSaveState("error");
    }
  };

  const updateField = (key: string, value: unknown) => {
    const next = { ...props, [key]: value };
    setProps(next);
    if (propsTimer.current) clearTimeout(propsTimer.current);
    propsTimer.current = setTimeout(() => {
      void patch({ properties: next });
      onChange?.({ properties: next });
    }, 700);
  };

  const scheduleSave = (value: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void patch({ content: value });
      onChange?.({ content: value });
    }, 700);
  };

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (propsTimer.current) clearTimeout(propsTimer.current);
    },
    [],
  );

  const remove = async () => {
    await api.del(`/blocks/${block.id}`);
    emitBlockDeleted(block.id);
    onDeleted(block.id);
  };

  const banner = (props.banner as BannerValue | null) ?? null;
  return (
    <div className="card" onPointerDownCapture={() => selectBlock(block.id)}>
      {!hideBanner && !compact && banner && (
        <Banner value={banner} editable onChange={(v) => updateField("banner", v ?? null)} height={150} />
      )}
      {!hideBanner && compact && banner && <Banner value={banner} height={110} className="banner-slice" />}
      {!hideBanner && !compact && !banner && (
        <div className="text-banner-add-row">
          <BannerAddButton onAdded={(v) => updateField("banner", v)} />
        </div>
      )}
      {compact ? (
        // Masonry preview: text-note icon + the first line as a (truncated)
        // title. Expand the card to edit the body.
        <div className="typed-head">
          <BlockIcon iconKey="type" size={20} />
          <span className="text-head-title">
            {oneLineText(block.properties, block.content) || "Empty note"}
          </span>
        </div>
      ) : (
        <MarkdownEditor
          key={ext.nonce}
          value={ext.content}
          onChange={scheduleSave}
          placeholder="Write a note…"
          autofocus={!block.content}
          blockId={block.id}
        />
      )}

      {bodyFields.length > 0 && (
        <div className="typed-fields">
          {bodyFields.map((f) => (
            <label
              className={`field typed-field${
                f.type === "text" ||
                f.type === "longtext" ||
                f.type === "url" ||
                f.type === "datespan" ||
                f.type === "attachments"
                  ? " full"
                  : ""
              }`}
              key={f.key}
            >
              <span>{f.label ?? f.key.replace(/_/g, " ")}</span>
              <FieldInput
                field={f}
                value={props[f.key]}
                onChange={(v) => updateField(f.key, v)}
                blockId={block.id}
              />
            </label>
          ))}
        </div>
      )}

      {compact && hasAttachField ? (
        <div className="tags-line">
          <AttachmentsChip blockId={block.id} />
          <TagEditor blockId={block.id} refresh={tagsRefresh} />
        </div>
      ) : (
        <TagEditor blockId={block.id} refresh={tagsRefresh} />
      )}
      <div className="block-meta">
        <span className="meta-dates">
          Created {fmtDateTime(block.createdAt)} · Edited {fmtDateTime(updatedAt)}
        </span>
        {saveState === "saving" && <span>saving…</span>}
        {saveState === "error" && <span className="error">save failed</span>}
        <span style={{ flex: 1 }} />
        {canDelete && (
          <button className="ghost" onClick={() => setConfirmOpen(true)}>
            Delete
          </button>
        )}
      </div>

      {canDelete && (
        <ConfirmDialog
          open={confirmOpen}
          title="Delete this note?"
          message="This permanently removes the block and its embedding. This can't be undone."
          confirmLabel="Delete"
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => {
            setConfirmOpen(false);
            void remove();
          }}
        />
      )}
    </div>
  );
}
