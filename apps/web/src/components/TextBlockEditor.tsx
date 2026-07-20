import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Block } from "../api.ts";

type SaveState = "idle" | "saving" | "error";

/**
 * Rich-prose editor for a single text block (design doc: TipTap is scoped to
 * text-block content only). Owns its own draft + version; autosaves debounced.
 * The server strips this HTML to plain text for the embedding.
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
  const versionRef = useRef(block.version);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: "Write a note…" }),
    ],
    content: block.content ?? "",
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void save(html), 700);
    },
  });

  const save = async (html: string) => {
    setSaveState("saving");
    try {
      const updated = await api.patch<Block>(`/blocks/${block.id}`, {
        content: html,
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

  useEffect(() => () => timer.current && clearTimeout(timer.current), []);

  const remove = async () => {
    await api.del(`/blocks/${block.id}`);
    onDeleted(block.id);
  };

  return (
    <div className="card">
      <EditorContent editor={editor} />
      <div className="block-meta">
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
        <button className="ghost" onClick={() => void remove()}>
          Delete
        </button>
      </div>
    </div>
  );
}
