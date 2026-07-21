import Placeholder from "@tiptap/extension-placeholder";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef, useState } from "react";
import { Markdown } from "tiptap-markdown";
import { api, ApiError, type Block, type BlockType } from "../api.ts";
import { CheckboxInput, HeadingIndent, SmartEnter } from "../lib/heading-indent.ts";
import { fmtDateTime } from "../lib/format.ts";
import { usePanels } from "../lib/right-panel.tsx";
import { AttachmentsChip } from "./AttachmentsField.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { FieldInput } from "./FieldInput.tsx";
import { TagEditor } from "./TagEditor.tsx";

type SaveState = "idle" | "saving" | "error";
type Mode = "live" | "raw";

/**
 * Soft line breaks (single Enter) become single newlines; paragraph breaks
 * (double Enter) stay as one blank line. Strip backslash hard-breaks, cap runs
 * of blank lines at one.
 */
function normalizeMarkdown(md: string): string {
  return md
    .replace(/\\\n/g, "\n") // backslash hard-breaks -> plain newline
    .replace(/\n{3,}/g, "\n\n") // at most one blank line
    .trim();
}

/**
 * Text block editor. "Live" is a WYSIWYG surface you type directly on; "Raw" is
 * the markdown source in a textarea. Content is stored as markdown either way
 * (TipTap serializes via tiptap-markdown). Both modes autosave (debounced) with
 * optimistic-concurrency handling.
 */
export function TextBlockEditor({
  block,
  type,
  onConflict,
  onDeleted,
  canDelete = true,
  compact = false,
}: {
  block: Block;
  type?: BlockType;
  onConflict: () => void;
  onDeleted: (id: string) => void;
  canDelete?: boolean;
  compact?: boolean;
}) {
  const [mode, setMode] = useState<Mode>("live");
  const [markdown, setMarkdown] = useState(block.content ?? "");
  const [props, setProps] = useState<Record<string, unknown>>(block.properties ?? {});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [updatedAt, setUpdatedAt] = useState(block.updatedAt);
  const versionRef = useRef(block.version);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const propsTimer = useRef<ReturnType<typeof setTimeout>>();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const { setSelectedBlockId } = usePanels();

  // The body IS the "description" field; any other schema fields render below it.
  const extraFields = [...(type?.propertySchema?.fields ?? [])]
    .filter((f) => f.key !== "description")
    .sort((a, b) => a.order - b.order);
  const hasAttachField = extraFields.some((f) => f.type === "attachments");
  const bodyFields = compact ? extraFields.filter((f) => f.type !== "attachments") : extraFields;

  const saveProps = async (next: Record<string, unknown>) => {
    setSaveState("saving");
    try {
      const updated = await api.patch<Block>(`/blocks/${block.id}`, {
        properties: next,
        version: versionRef.current,
      });
      versionRef.current = updated.version;
      setUpdatedAt(updated.updatedAt);
      setSaveState("idle");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) return onConflict();
      setSaveState("error");
    }
  };
  const updateField = (key: string, value: unknown) => {
    const next = { ...props, [key]: value };
    setProps(next);
    if (propsTimer.current) clearTimeout(propsTimer.current);
    propsTimer.current = setTimeout(() => void saveProps(next), 700);
  };

  const save = async (value: string) => {
    setSaveState("saving");
    try {
      const updated = await api.patch<Block>(`/blocks/${block.id}`, {
        content: value,
        version: versionRef.current,
      });
      versionRef.current = updated.version;
      setUpdatedAt(updated.updatedAt);
      setSaveState("idle");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        onConflict();
        return;
      }
      setSaveState("error");
    }
  };

  const scheduleSave = (value: string) => {
    setMarkdown(value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(value), 700);
  };

  const editor = useEditor({
    extensions: [
      StarterKit,
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown.configure({ breaks: true, transformPastedText: true }),
      Placeholder.configure({ placeholder: "Write a note…" }),
      CheckboxInput,
      SmartEnter,
      HeadingIndent,
    ],
    content: block.content ?? "",
    autofocus: block.content ? false : "end",
    editorProps: { attributes: { class: "note-editor" } },
    onUpdate: ({ editor }) => {
      const md = normalizeMarkdown(editor.storage.markdown.getMarkdown() as string);
      scheduleSave(md);
    },
  });

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (propsTimer.current) clearTimeout(propsTimer.current);
    },
    [],
  );

  const autosize = () => {
    const el = taRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  };
  useEffect(() => {
    if (mode === "raw") autosize();
  }, [mode]);

  const toggle = () => {
    if (mode === "live") {
      // markdown state is kept current by onUpdate — just show the source.
      setMode("raw");
    } else {
      // reparse edited markdown back into the WYSIWYG doc (no re-emit).
      editor?.commands.setContent(markdown, false);
      setMode("live");
    }
  };

  const onRawChange = (value: string) => {
    scheduleSave(value);
    autosize();
  };

  const remove = async () => {
    await api.del(`/blocks/${block.id}`);
    onDeleted(block.id);
  };

  return (
    <div className="card" onPointerDownCapture={() => setSelectedBlockId(block.id)}>
      {mode === "live" ? (
        <EditorContent editor={editor} />
      ) : (
        <textarea
          ref={taRef}
          className="md-input"
          value={markdown}
          placeholder="Write a note… (markdown)"
          onChange={(e) => onRawChange(e.target.value)}
          autoFocus
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
          <TagEditor blockId={block.id} />
        </div>
      ) : (
        <TagEditor blockId={block.id} />
      )}
      <div className="block-meta">
        <button className="ghost" onClick={toggle}>
          {mode === "live" ? "Raw" : "Live preview"}
        </button>
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
