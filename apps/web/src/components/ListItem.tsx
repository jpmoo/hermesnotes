import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, ChevronRight, GripVertical, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type Block, type BlockType, type Member } from "../api.ts";
import { emitBlockChange, useBlockOrigin, useBlockSync } from "../lib/block-events.ts";
import { BlockIcon } from "../lib/icons.tsx";
import { oneLineHtml, oneLineText } from "../lib/display.ts";
import { usePanels } from "../lib/right-panel.tsx";
import { MentionTextInput } from "./MentionTextInput.tsx";
import { TextBlockEditor } from "./TextBlockEditor.tsx";
import { TypedBlockCard } from "./TypedBlockCard.tsx";

export type ListFormat = "bullet" | "ordered" | "checklist" | "blocks";

/** One sortable list row. Owns its own inline edit + autosave. */
export function ListItem({
  member,
  type,
  index,
  format,
  syncStatus,
  collectionId,
  onRemove,
  onMemberChange,
  readonly = false,
  expandSignal,
}: {
  member: Member;
  type: BlockType | undefined;
  index: number;
  format: ListFormat;
  syncStatus: boolean;
  collectionId: string;
  onRemove: (blockId: string) => void;
  onMemberChange: (id: string, patch: { properties?: Record<string, unknown>; content?: string | null }) => void;
  readonly?: boolean;
  expandSignal?: { open: boolean; nonce: number };
}) {
  const sortable = useSortable({ id: member.id });
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  const { selectBlock, selectOrOpen } = usePanels();

  const isText = !type || type.isText;
  const schema = type?.propertySchema ?? null;
  const statusKey = schema?.status_field ?? null;
  const statusField = schema?.fields.find((f) => f.type === "status" && f.key === statusKey) ?? null;

  const asCard = format === "blocks";
  const [content, setContent] = useState(member.content ?? "");
  const [props, setProps] = useState<Record<string, unknown>>(member.properties ?? {});
  const [checked, setChecked] = useState(Boolean(member.context?.checked));
  const [expanded, setExpanded] = useState(asCard);
  const [fullBlock, setFullBlock] = useState<Block | null>(null);
  const versionRef = useRef(member.version);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  // Cross-surface sync (e.g. edits made in the info panel appear in the row).
  const origin = useBlockOrigin();
  useBlockSync(member.id, origin, (b) => {
    versionRef.current = b.version;
    setProps(b.properties ?? {});
    setContent(b.content ?? "");
    setFullBlock(null); // expanded card refetches lazily
  });

  // Expand/collapse-all broadcast from the toolbar.
  useEffect(() => {
    if (expandSignal) setExpanded(expandSignal.open);
  }, [expandSignal]);

  // The member already carries the block's content/properties/version, so if the
  // full fetch fails or hangs we fall back to it rather than getting stuck on
  // "Loading…". (The card components don't read blockTypeId/embed fields.)
  const asBlock = (): Block => ({
    id: member.id,
    blockTypeId: member.blockTypeId ?? "",
    collectionKind: member.collectionKind,
    content: member.content,
    properties: member.properties,
    embeddedAt: null,
    embedPending: false,
    version: member.version,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt,
  });

  useEffect(() => {
    // Blocks format always shows the card, so fetch when asCard even if
    // `expanded` is a stale false (e.g. after switching format bullet→blocks
    // on a reused row) — otherwise the card hangs on "Loading…".
    if ((!expanded && !asCard) || fullBlock) return;
    let done = false;
    const fallback = () => {
      if (!done) {
        done = true;
        setFullBlock(asBlock());
      }
    };
    const timer = setTimeout(fallback, 5000);
    api
      .get<Block>(`/blocks/${member.id}`)
      .then((b) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          setFullBlock(b);
        }
      })
      .catch(() => {
        clearTimeout(timer);
        fallback();
      });
    return () => {
      done = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, asCard, fullBlock, member.id]);
  const reloadFull = () => void api.get<Block>(`/blocks/${member.id}`).then(setFullBlock).catch(() => {});

  // Expanding an item makes it the active block in the info panel.
  const openItem = () => {
    setExpanded(true);
    selectBlock(member.id);
  };
  const toggleItem = () => {
    setExpanded((x) => {
      if (!x) selectBlock(member.id);
      return !x;
    });
  };

  const patchBlock = async (body: Record<string, unknown>) => {
    try {
      const updated = await api.patch<Member>(`/blocks/${member.id}`, {
        ...body,
        version: versionRef.current,
      });
      versionRef.current = updated.version;
      emitBlockChange(member.id, origin);
    } catch {
      /* keep local; a refresh will reconcile */
    }
  };

  const debouncedText = (value: string) => {
    if (isText) setContent(value);
    else setProps((p) => ({ ...p, title: value }));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (isText) {
        void patchBlock({ content: value });
        onMemberChange(member.id, { content: value });
      } else {
        const next = { ...props, title: value };
        void patchBlock({ properties: next });
        onMemberChange(member.id, { properties: next });
      }
    }, 600);
  };

  const status = statusKey ? String(props[statusKey] ?? "") : "";
  const isComplete = Boolean(statusField && schema?.complete_values?.includes(status));

  const cycleStatus = () => {
    if (!statusField) return;
    const opts = statusField.options ?? [];
    const next = opts[(opts.indexOf(status) + 1) % opts.length];
    if (next) {
      const nextProps = { ...props, [statusKey!]: next };
      setProps(nextProps);
      void patchBlock({ properties: nextProps });
      onMemberChange(member.id, { properties: nextProps });
    }
  };

  const toggleCheck = () => {
    if (statusField && syncStatus) {
      const completeVals = schema?.complete_values ?? [];
      const next = isComplete ? String(schema?.default_value ?? "") : String(completeVals[0] ?? "");
      const nextProps = { ...props, [statusKey!]: next };
      setProps(nextProps);
      void patchBlock({ properties: nextProps });
      onMemberChange(member.id, { properties: nextProps });
    } else {
      setChecked((c) => !c);
      void api.patch(`/collections/${collectionId}/members/${member.id}`, {
        context: { checked: !checked },
      });
    }
  };

  const boxChecked = statusField && syncStatus ? isComplete : checked;
  const multiline = isText && content.includes("\n");
  const restCount = (schema?.fields ?? []).filter(
    (f) => f.key !== "title" && f.key !== statusKey,
  ).length;
  const hasMore = isText ? multiline || content.length > 80 : restCount > 0;

  // "blocks" format: every item is a full editable card with the drag handle to
  // its left (no header row) and a hover remove button.
  if (asCard) {
    return (
      <div ref={sortable.setNodeRef} style={style} data-block-id={member.id} className="list-item-wrap block-item block-row">
        {!readonly && (
          <button
            className="drag-handle bv-grip"
            {...sortable.attributes}
            {...sortable.listeners}
            title="Drag to reorder"
          >
            <GripVertical size={15} />
          </button>
        )}
        <div className="block-row-body">
          {!fullBlock ? (
            <div className="hint">Loading…</div>
          ) : isText ? (
            <TextBlockEditor block={fullBlock} type={type} onConflict={reloadFull} onDeleted={() => onRemove(member.id)} onChange={(p) => onMemberChange(member.id, p)} />
          ) : (
            <TypedBlockCard block={fullBlock} type={type!} onConflict={reloadFull} onDeleted={() => onRemove(member.id)} onChange={(p) => onMemberChange(member.id, p)} />
          )}
        </div>
        {!readonly && (
          <button
            className="icon-btn li-remove block-row-remove"
            title="Remove"
            onClick={() => onRemove(member.id)}
          >
            <X size={14} />
          </button>
        )}
      </div>
    );
  }

  return (
    <div ref={sortable.setNodeRef} style={style} data-block-id={member.id} className="list-item-wrap">
      <div
        className={`list-item${boxChecked && format === "checklist" ? " done" : ""}`}
        // On a phone, tapping the row (anywhere that isn't a control or the
        // row's own editable text) opens the block as a page — the info panel
        // is an off-screen drawer there, so selecting looks like nothing.
        onClick={(e) => {
          const el = e.target as HTMLElement;
          if (el.closest("input, textarea, select, button, a, [contenteditable='true'], .dtp, .mention-chip")) {
            return;
          }
          selectOrOpen(member.id);
        }}
      >
        {!readonly && (
          <button className="drag-handle" {...sortable.attributes} {...sortable.listeners} title="Drag to reorder">
            <GripVertical size={15} />
          </button>
        )}

        {format === "checklist" ? (
          <input type="checkbox" checked={boxChecked} onChange={toggleCheck} className="li-check" />
        ) : format === "ordered" ? (
          <span className="li-marker">{index + 1}.</span>
        ) : (
          <span className="li-marker">•</span>
        )}

        {statusField && format !== "checklist" ? (
          <button className="li-status" onClick={cycleStatus} title={`Status: ${status.replace(/_/g, " ")}`}>
            <BlockIcon
              iconKey={statusField.optionIcons?.[status] ?? type?.iconKey}
              color={statusField.optionColors?.[status] ?? type?.iconColor}
              size={17}
            />
          </button>
        ) : (
          <span className="li-type" title={isText ? "Note" : type?.name}>
            <BlockIcon iconKey={isText ? "type" : type?.iconKey} color={isText ? null : type?.iconColor} size={17} />
          </span>
        )}

        {isText ? (
          <span
            className="li-text li-text-static li-md"
            onClick={openItem}
            dangerouslySetInnerHTML={{
              __html: oneLineHtml(props, content) || '<span class="li-empty">Empty note</span>',
            }}
          />
        ) : !expanded ? (
          <MentionTextInput
            className="li-text li-text-mention"
            value={String(props.title ?? "")}
            placeholder={type?.name}
            onFocus={() => selectBlock(member.id)}
            onChange={debouncedText}
          />
        ) : (
          <span className="li-text li-text-static" onClick={openItem}>
            {oneLineText(props) || type?.name || "Item"}
          </span>
        )}

        {hasMore && (
          <button
            className="icon-btn li-expand"
            title={expanded ? "Collapse" : "Expand"}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              toggleItem();
            }}
          >
            {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </button>
        )}
        {!readonly && (
          <button className="icon-btn li-remove" title="Remove" onClick={() => onRemove(member.id)}>
            <X size={14} />
          </button>
        )}
      </div>

      {expanded && (
        <div className="list-item-expanded">
          {!fullBlock ? (
            <div className="hint">Loading…</div>
          ) : isText ? (
            <TextBlockEditor block={fullBlock} type={type} onConflict={reloadFull} onDeleted={() => onRemove(member.id)} onChange={(p) => onMemberChange(member.id, p)} />
          ) : (
            <TypedBlockCard block={fullBlock} type={type!} onConflict={reloadFull} onDeleted={() => onRemove(member.id)} onChange={(p) => onMemberChange(member.id, p)} />
          )}
        </div>
      )}
    </div>
  );
}
