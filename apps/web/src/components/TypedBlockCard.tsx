import { isComplete, type FieldDef } from "@hermes/shared";
import { useEffect, useRef, useState } from "react";
import type { BlockType, Block } from "../api.ts";
import { api, ApiError } from "../api.ts";
import { BlockIcon } from "../lib/icons.tsx";
import { renderFeedText } from "../lib/feed-text.tsx";
import { fmtDateTime } from "../lib/format.ts";
import { emitBlockChange, emitBlockDeleted, useBlockOrigin, useBlockSync } from "../lib/block-events.ts";
import { useRegisterEditor } from "../lib/editor-registry.ts";
import { isEditingTarget } from "../lib/editing-target.ts";
import { usePanels } from "../lib/right-panel.tsx";
import { AttachmentsChip } from "./AttachmentsField.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { Banner, BannerAddButton, type BannerValue } from "./Banner.tsx";
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
  archived = false,
  hideBanner = false,
  noRegister = false,
}: {
  block: Block;
  type: BlockType;
  onConflict: () => void;
  onDeleted: (id: string) => void;
  onChange?: (patch: { properties?: Record<string, unknown>; content?: string | null }) => void;
  compact?: boolean;
  /** In the Archive view: offer Unarchive + permanent Delete instead of Archive. */
  archived?: boolean;
  /** Suppress all banner UI (display + add button), e.g. in the info panel. */
  hideBanner?: boolean;
  /** Don't register as a viewport editor (the info panel's own instance). */
  noRegister?: boolean;
}) {
  useRegisterEditor(block.id, !noRegister);
  const [props, setProps] = useState<Record<string, unknown>>(block.properties ?? {});
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [confirm, setConfirm] = useState<null | "archive" | "unarchive" | "delete">(null);
  const [updatedAt, setUpdatedAt] = useState(block.updatedAt);
  const versionRef = useRef(block.version);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  // Latest not-yet-saved edit, so a pending debounce can be flushed on unmount
  // (leaving the card — e.g. expanding to the viewport — before the 700ms fired
  // must not drop the change).
  const pendingProps = useRef<Record<string, unknown> | null>(null);
  // Which fields the user actually edited, so a version conflict can re-apply
  // exactly those onto the server's newer state instead of losing them.
  const pendingKeys = useRef<Set<string>>(new Set());
  const dirty = () => pendingProps.current != null;
  // Any field in this card holding focus also holds off remote updates — a pause
  // longer than the debounce must not let one remount the editor under the caret.
  const focusedRef = useRef(false);
  const { selectBlock, selectOrOpen } = usePanels();

  // Cross-surface sync: announce saves; adopt foreign edits of this block — but
  // hold a remote edit while you have unsaved changes here, so it can't overwrite
  // a field you're mid-typing. Released once the pending save settles.
  const origin = useBlockOrigin();
  // A longtext field's markdown editor owns its content internally, so a changed
  // `value` prop alone won't update it — adopting a foreign edit has to remount
  // the fields (bumped nonce below). Only ever happens when we're not dirty, so
  // it can't interrupt typing.
  const [ext, setExt] = useState(0);
  const releaseSync = useBlockSync(
    block.id,
    origin,
    (b) => {
      setProps(b.properties ?? {});
      versionRef.current = b.version;
      setUpdatedAt(b.updatedAt);
      setExt((n) => n + 1);
    },
    () => focusedRef.current || dirty(),
  );

  // A newer snapshot from whoever owns this card (the info panel refetches when
  // it takes over editing, and hands the fresh block down). Adopted only when
  // nothing here is in flight — the same hold the sync bus uses — so it can't
  // overwrite what you're in the middle of.
  useEffect(() => {
    if (block.version === versionRef.current) return;
    if (focusedRef.current || dirty()) return;
    setProps(block.properties ?? {});
    versionRef.current = block.version;
    setUpdatedAt(block.updatedAt);
    setExt((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [block.id, block.version]);

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

  const save = async (next: Record<string, unknown>, isRetry = false) => {
    setSaveState("saving");
    const edited = [...pendingKeys.current];
    try {
      const updated = await api.patch<Block & { recurred?: boolean }>(`/blocks/${block.id}`, {
        properties: next,
        version: versionRef.current,
      });
      versionRef.current = updated.version;
      setUpdatedAt(updated.updatedAt);
      setSaveState("idle");
      pendingKeys.current.clear();
      emitBlockChange(block.id, origin);
      // A remote change that arrived mid-edit was held; now that we're settled
      // and not typing, catch up to it.
      if (!dirty()) releaseSync();
      // A recurring task just spawned its next occurrence — refresh the list.
      if (updated.recurred) onConflict();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Something else wrote first — another tab, the assistant over MCP, a
        // calendar-feed mirror. Never answer that by discarding what the user
        // typed: re-apply just the fields they actually edited on top of the
        // server's current state and save once more. Only then give up.
        if (!isRetry && edited.length) {
          try {
            const fresh = await api.get<Block>(`/blocks/${block.id}`);
            versionRef.current = fresh.version;
            const merged = { ...((fresh.properties ?? {}) as Record<string, unknown>) };
            for (const key of edited) merged[key] = next[key];
            setProps(merged);
            await save(merged, true);
            return;
          } catch {
            /* couldn't reconcile — fall through to the host's conflict handler */
          }
        }
        onConflict();
        return;
      }
      setSaveState("error");
    }
  };

  const update = (key: string, value: unknown) => {
    const next = { ...props, [key]: value };
    setProps(next);
    pendingProps.current = next;
    pendingKeys.current.add(key);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      pendingProps.current = null;
      void save(next);
      onChange?.({ properties: next });
    }, 700);
  };

  // Flush a pending debounced save immediately (used on unmount) so navigating
  // away or expanding this card into the viewport before the 700ms fires can't
  // silently drop the edit.
  const flushSaves = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
    if (pendingProps.current != null) {
      const next = pendingProps.current;
      pendingProps.current = null;
      void save(next);
    }
  };
  const flushRef = useRef(flushSaves);
  flushRef.current = flushSaves;

  useEffect(
    () => () => {
      flushRef.current();
    },
    [],
  );

  // Show archived-mode actions whenever the block is actually archived — the
  // page prop is a hint, but the block's own state is the source of truth (an
  // archived block opened in the info pane must still offer Unarchive).
  const isArchived = archived || block.archivedAt != null;

  // Archive replaces deletion in normal views (reversible); the block drops out
  // of the current list via the same delete event.
  const archive = async () => {
    await api.post(`/blocks/${block.id}/archive`, {});
    emitBlockDeleted(block.id);
    onDeleted(block.id);
  };
  const unarchive = async () => {
    await api.post(`/blocks/${block.id}/unarchive`, {});
    emitBlockDeleted(block.id);
    onDeleted(block.id);
  };
  const remove = async () => {
    await api.del(`/blocks/${block.id}`);
    emitBlockDeleted(block.id);
    onDeleted(block.id);
  };

  const banner = (props.banner as BannerValue | null) ?? null;
  // A joined calendar-feed event carries the feed's own description. It's the
  // feed's text, not the user's, so it shows read-only beside their description
  // (see FEED_NOTES_KEY, apps/server/src/calendar/routes.ts). The key's presence
  // — not its content — is what marks the event as joined, so an empty one still
  // shows the section rather than silently vanishing.
  const feedNotes = typeof props.feed_description === "string" ? props.feed_description.trim() : null;
  return (
    <div
      className="card typed-card"
      // A compact card is a preview (a canvas node, a masonry tile), so a tap on
      // it means "open this" — and on a phone that has to be a page, since the
      // info panel is an off-screen drawer. A full card IS the editor; tapping
      // into one is editing and must never navigate away.
      onPointerDownCapture={(e) =>
        isEditingTarget(e.target) ? undefined : compact ? selectOrOpen(block.id) : selectBlock(block.id)
      }
      onFocusCapture={() => {
        focusedRef.current = true;
      }}
      onBlurCapture={() => {
        focusedRef.current = false;
        // Settled: adopt any remote edit that was held while editing here.
        if (!dirty()) releaseSync();
      }}
    >
      {!compact && !hideBanner && banner && (
        <Banner value={banner} editable onChange={(v) => update("banner", v ?? null)} height={150} />
      )}
      {compact && !hideBanner && banner && <Banner value={banner} height={110} className="banner-slice" />}
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
        {!compact && !hideBanner && !banner && (
          <BannerAddButton className="head-banner-add" onAdded={(v) => update("banner", v)} />
        )}
      </div>

      {bodyFields.length > 0 && (
        <div className="typed-fields">
          {bodyFields.map((f) => {
            const full =
              f.type === "text" ||
              f.type === "longtext" ||
              f.type === "url" ||
              f.type === "datespan" ||
              f.type === "reference" ||
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
              // Only the long-text fields carry the remount nonce. Their editor
              // owns its content internally, so a changed value prop alone won't
              // update it — but keying the WHOLE field list by that nonce tore
              // down every other field with it, and a foreign edit lands here
              // constantly (this card adopts the viewport's saves). That took the
              // reference field's search box apart mid-word: its query, its
              // results and its open state are component state, so a remount
              // silently emptied them and the list stopped answering.
              <Tag
                className={`field typed-field${full ? " full" : ""}`}
                key={f.type === "longtext" ? `${f.key}:${ext}` : f.key}
              >
                <span>{f.label ?? f.key.replace(/_/g, " ")}</span>
                <FieldInput
                  field={f}
                  value={props[f.key]}
                  onChange={(v) => update(f.key, v)}
                  blockId={block.id}
                  showOverdue={Boolean(schema && schema.status_field && !isComplete(schema, props))}
                />
              </Tag>
            );
          })}
        </div>
      )}

      {!compact && feedNotes !== null && (
        <div className="field typed-field full feed-notes">
          <span>Feed description</span>
          {feedNotes ? (
            <div className="feed-notes-body">{renderFeedText(feedNotes)}</div>
          ) : (
            <div className="feed-notes-body empty">(empty)</div>
          )}
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
        {isArchived ? (
          <>
            <button className="ghost" onClick={() => setConfirm("unarchive")}>
              Unarchive
            </button>
            <button className="danger" onClick={() => setConfirm("delete")}>
              Delete
            </button>
          </>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm === "archive"
            ? `Archive this ${type.name}?`
            : confirm === "unarchive"
              ? `Unarchive this ${type.name}?`
              : `Delete this ${type.name}?`
        }
        message={
          confirm === "archive"
            ? "It'll be hidden from every normal view but kept in the Archive — unarchive anytime to restore it where it was."
            : confirm === "unarchive"
              ? "It'll return to every view it was in."
              : "This permanently removes the block and its embedding. This can't be undone."
        }
        confirmLabel={confirm === "archive" ? "Archive" : confirm === "unarchive" ? "Unarchive" : "Delete"}
        danger={confirm === "delete"}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const action = confirm;
          setConfirm(null);
          if (action === "archive") void archive();
          else if (action === "unarchive") void unarchive();
          else if (action === "delete") void remove();
        }}
      />
    </div>
  );
}
