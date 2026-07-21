import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "tiptap-markdown";
import { CheckboxInput, HeadingIndent, SmartEnter } from "../lib/heading-indent.ts";
import { Mentions, type MentionHandlers, type MentionState } from "../lib/mentions.ts";
import { MentionMenu } from "./MentionMenu.tsx";

type Mode = "live" | "raw";

/** Soft breaks → newlines; strip backslash hard-breaks; cap blank-line runs. */
function normalizeMarkdown(md: string): string {
  return md
    .replace(/\\\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The shared markdown editing surface — a live WYSIWYG (with a Raw/Live toggle)
 * that expands as you type. Supports links and inline mentions: `@` people, `#`
 * tags, `|` any other type. Value is markdown.
 */
export function MarkdownEditor({
  value,
  onChange,
  placeholder = "Write…",
  autofocus = false,
}: {
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  autofocus?: boolean;
}) {
  const [mode, setMode] = useState<Mode>("live");
  const [markdown, setMarkdown] = useState(value);
  const [sug, setSug] = useState<MentionState | null>(null);
  const keydown = useRef<((e: KeyboardEvent) => boolean) | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const handlers = useMemo<MentionHandlers>(
    () => ({ onOpen: setSug, onUpdate: setSug, onClose: () => setSug(null), keydown }),
    [],
  );

  const editor = useEditor({
    extensions: [
      StarterKit,
      Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown.configure({ breaks: true, transformPastedText: true }),
      Placeholder.configure({ placeholder }),
      CheckboxInput,
      SmartEnter,
      HeadingIndent,
      Mentions.configure({ handlers }),
    ],
    content: value,
    autofocus: autofocus ? "end" : false,
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
    <div className="md-editor">
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
      {sug && <MentionMenu state={sug} keydown={keydown} onClose={() => setSug(null)} />}
    </div>
  );
}
