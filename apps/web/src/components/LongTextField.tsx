import Placeholder from "@tiptap/extension-placeholder";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef, useState } from "react";
import { Markdown } from "tiptap-markdown";
import { CheckboxInput, HeadingIndent, SmartEnter } from "../lib/heading-indent.ts";

type Mode = "live" | "raw";

/** Soft breaks → newlines; strip backslash hard-breaks; cap blank-line runs. */
function normalizeMarkdown(md: string): string {
  return md
    .replace(/\\\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * A paragraph-sized markdown editor — the same surface as a note body: a live
 * WYSIWYG that expands as you type, with a Raw/Live toggle. Value is markdown.
 * Used by the `longtext` field type.
 */
export function LongTextField({
  value,
  onChange,
  placeholder = "Write…",
}: {
  value: unknown;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const initial = typeof value === "string" ? value : "";
  const [mode, setMode] = useState<Mode>("live");
  const [markdown, setMarkdown] = useState(initial);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const editor = useEditor({
    extensions: [
      StarterKit,
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown.configure({ breaks: true, transformPastedText: true }),
      Placeholder.configure({ placeholder }),
      CheckboxInput,
      SmartEnter,
      HeadingIndent,
    ],
    content: initial,
    editorProps: { attributes: { class: "note-editor" } },
    onUpdate: ({ editor }) => {
      const md = normalizeMarkdown(editor.storage.markdown.getMarkdown() as string);
      setMarkdown(md);
      onChange(md);
    },
  });

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
      setMode("raw");
    } else {
      editor?.commands.setContent(markdown, false);
      setMode("live");
    }
  };

  const onRawChange = (v: string) => {
    setMarkdown(v);
    onChange(normalizeMarkdown(v));
    autosize();
  };

  return (
    <div className="longtext">
      {mode === "live" ? (
        <EditorContent editor={editor} />
      ) : (
        <textarea
          ref={taRef}
          className="md-input"
          value={markdown}
          placeholder={`${placeholder} (markdown)`}
          onChange={(e) => onRawChange(e.target.value)}
        />
      )}
      <button className="ghost longtext-toggle" onClick={toggle} type="button">
        {mode === "live" ? "Raw" : "Live preview"}
      </button>
    </div>
  );
}
