import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Block } from "../api.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

marked.setOptions({ gfm: true, breaks: true });

type SaveState = "idle" | "saving" | "error";
type Mode = "edit" | "preview";

function renderMarkdown(src: string): string {
  const html = marked.parse(src ?? "", { async: false }) as string;
  return DOMPurify.sanitize(html);
}

/**
 * Markdown text block. Raw mode is a plain textarea (no auto-formatting
 * surprises); Preview renders the markdown. Content is stored as markdown and
 * embedded as-is. Autosaves debounced with optimistic-concurrency handling.
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
  const [text, setText] = useState(block.content ?? "");
  const [mode, setMode] = useState<Mode>(block.content ? "preview" : "edit");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const versionRef = useRef(block.version);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const taRef = useRef<HTMLTextAreaElement>(null);

  const autosize = () => {
    const el = taRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  };

  useEffect(() => {
    if (mode === "edit") autosize();
  }, [mode]);

  useEffect(() => () => timer.current && clearTimeout(timer.current), []);

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

  const onChange = (value: string) => {
    setText(value);
    autosize();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(value), 700);
  };

  const remove = async () => {
    await api.del(`/blocks/${block.id}`);
    onDeleted(block.id);
  };

  return (
    <div className="card">
      {mode === "edit" ? (
        <textarea
          ref={taRef}
          className="md-input"
          value={text}
          placeholder="Write a note… (markdown supported)"
          onChange={(e) => onChange(e.target.value)}
          autoFocus={!block.content}
        />
      ) : (
        <div
          className="markdown"
          title="Double-click to edit"
          onDoubleClick={() => setMode("edit")}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
        />
      )}
      <div className="block-meta">
        <button className="ghost" onClick={() => setMode(mode === "edit" ? "preview" : "edit")}>
          {mode === "edit" ? "Preview" : "Edit"}
        </button>
        {block.embedPending ? (
          <span className="pill pending">embedding…</span>
        ) : block.embeddedAt ? (
          <span className="pill embedded">embedded</span>
        ) : (
          <span className="pill">not embedded</span>
        )}
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
