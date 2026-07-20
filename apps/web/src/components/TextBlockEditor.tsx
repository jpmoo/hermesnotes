import Placeholder from "@tiptap/extension-placeholder";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef, useState } from "react";
import { Markdown } from "tiptap-markdown";
import { api, ApiError, type Block } from "../api.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

type SaveState = "idle" | "saving" | "error";
type Mode = "live" | "raw";

/** Collapse the extra blank lines tiptap-markdown emits between blocks. */
function normalizeMarkdown(md: string): string {
  return md.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Text block editor. "Live" is a WYSIWYG surface you type directly on; "Raw" is
 * the markdown source in a textarea. Content is stored as markdown either way
 * (TipTap serializes via tiptap-markdown). Both modes autosave (debounced) with
 * optimistic-concurrency handling.
 */
export function TextBlockEditor({
  block,
  onConflict,
  onDeleted,
}: {
  block: Block;
  onConflict: () => void;
  onDeleted: (id: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("live");
  const [markdown, setMarkdown] = useState(block.content ?? "");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const versionRef = useRef(block.version);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const taRef = useRef<HTMLTextAreaElement>(null);

  const save = async (value: string) => {
    setSaveState("saving");
    try {
      const updated = await api.patch<Block>(`/blocks/${block.id}`, {
        content: value,
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
      Markdown.configure({ transformPastedText: true }),
      Placeholder.configure({ placeholder: "Write a note…" }),
    ],
    content: block.content ?? "",
    autofocus: block.content ? false : "end",
    editorProps: { attributes: { class: "note-editor" } },
    onUpdate: ({ editor }) => {
      const md = normalizeMarkdown(editor.storage.markdown.getMarkdown() as string);
      scheduleSave(md);
    },
  });

  useEffect(() => () => timer.current && clearTimeout(timer.current), []);

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
    <div className="card">
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
      <div className="block-meta">
        <button className="ghost" onClick={toggle}>
          {mode === "live" ? "Raw" : "Live preview"}
        </button>
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
        title="Delete this note?"
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
