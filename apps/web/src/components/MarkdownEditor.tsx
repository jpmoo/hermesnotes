import { Image as ImageIcon } from "lucide-react";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { EditorContent, useEditor } from "@tiptap/react";
import { api, type Attachment } from "../api.ts";
import { MdImage } from "../lib/image-node.ts";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "tiptap-markdown";
import { ActiveLineSource, SourceBlock } from "../lib/active-line-source.ts";
import { CheckboxInput, HeadingIndent, SmartEnter } from "../lib/heading-indent.ts";
import { patchMarkdownParser } from "../lib/markdown-fixups.ts";
import { linksToMentions, MentionNode } from "../lib/mention-node.ts";
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
  blockId,
}: {
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  autofocus?: boolean;
  /** Enables image paste/insert (images are stored as block attachments). */
  blockId?: string;
}) {
  const [mode, setMode] = useState<Mode>("live");
  const [imgMenu, setImgMenu] = useState<Attachment[] | null>(null);
  const [markdown, setMarkdown] = useState(value);
  const [sug, setSug] = useState<MentionState | null>(null);
  const keydown = useRef<((e: KeyboardEvent) => boolean) | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const lastEmit = useRef(value);

  const handlers = useMemo<MentionHandlers>(
    () => ({ onOpen: setSug, onUpdate: setSug, onClose: () => setSug(null), keydown }),
    [],
  );

  const editor = useEditor({
    extensions: [
      StarterKit,
      // Allow our custom mention schemes to survive markdown re-parsing (raw→live
      // and reload), so they convert back into mention chips.
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        protocols: ["block", "tag"],
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown.configure({ breaks: true, transformPastedText: true }),
      Placeholder.configure({ placeholder }),
      CheckboxInput,
      SmartEnter,
      HeadingIndent,
      MentionNode,
      MdImage,
      SourceBlock,
      ActiveLineSource,
      Mentions.configure({ handlers }),
    ],
    content: value,
    autofocus: autofocus ? "end" : false,
    editorProps: {
      attributes: { class: "note-editor" },
      // Mentions (block:/tag:) navigate via their chip; plain web links open in
      // a new tab. Intercept at mousedown: a click would first move the
      // selection, the active-line swap would turn the block into raw source,
      // and the anchor would vanish before handleClick ever saw it.
      // Pasted images upload to the block's attachments and drop in as
      // resizable inline images (deleting one never deletes the attachment).
      handlePaste: (view, event) => {
        if (!blockId) return false;
        const files = [...(event.clipboardData?.files ?? [])].filter((f) =>
          f.type.startsWith("image/"),
        );
        if (files.length === 0) return false;
        event.preventDefault();
        void (async () => {
          const form = new FormData();
          for (const f of files) form.append("file", f);
          try {
            const saved = await api.upload<Attachment[]>(`/blocks/${blockId}/attachments`, form);
            for (const att of saved) {
              const node = view.state.schema.nodes.mdImage!.create({
                src: `attachment:${att.id}`,
                alt: att.filename.replace(/\.[a-z0-9]+$/i, ""),
              });
              view.dispatch(view.state.tr.replaceSelectionWith(node));
            }
          } catch {
            /* upload failed; nothing inserted */
          }
        })();
        return true;
      },
      handleDOMEvents: {
        mousedown: (_view, event) => {
          if (event.button !== 0) return false;
          const a = (event.target as HTMLElement).closest?.("a[href]");
          const href = a?.getAttribute("href") ?? "";
          if (/^https?:\/\//i.test(href)) {
            event.preventDefault();
            window.open(href, "_blank", "noopener");
            return true;
          }
          return false;
        },
      },
    },
    onCreate: ({ editor }) => {
      // Patch the parser (fixes empty checkboxes on every later parse); the
      // initial content was already parsed before this, so re-parse it when it
      // contained a bare `- [ ]` so the starting doc is correct too.
      patchMarkdownParser(editor);
      if (/^\s*[-*+] \[[ xX]\]\s*$/m.test(value)) editor.commands.setContent(value, false);
      linksToMentions(editor);
    },
    onUpdate: ({ editor }) => {
      const md = normalizeMarkdown(editor.storage.markdown.getMarkdown() as string);
      setMarkdown(md);
      // Cursor-move source swaps (and link→mention conversion) don't change the
      // markdown — only emit real edits so they don't spuriously re-save.
      if (md === lastEmit.current) return;
      lastEmit.current = md;
      onChange(md);
    },
  });

  useEffect(() => {
    if (!imgMenu) return;
    const close = () => setImgMenu(null);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [imgMenu]);

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
      if (editor) linksToMentions(editor);
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
      {blockId && mode === "live" && (
        <span className="nav-kebab" style={{ position: "relative" }}>
          <button
            className="ghost longtext-toggle"
            type="button"
            title="Insert an attached image"
            onClick={() =>
              void api
                .get<Attachment[]>(`/blocks/${blockId}/attachments`)
                .then((all) => setImgMenu(all.filter((a) => a.mime.startsWith("image/"))))
                .catch(() => setImgMenu([]))
            }
          >
            <ImageIcon size={12} />
          </button>
          {imgMenu && (
            <div className="menu" style={{ left: 0, right: "auto", top: "auto", bottom: "calc(100% + 4px)" }}>
              {imgMenu.length === 0 && (
                <div className="hint" style={{ padding: "6px 10px" }}>
                  No image attachments — paste an image to add one.
                </div>
              )}
              {imgMenu.map((a) => (
                <button
                  key={a.id}
                  className="menu-item"
                  type="button"
                  onClick={() => {
                    editor
                      ?.chain()
                      .focus()
                      .insertContent({
                        type: "mdImage",
                        attrs: { src: `attachment:${a.id}`, alt: a.filename.replace(/\.[a-z0-9]+$/i, "") },
                      })
                      .run();
                    setImgMenu(null);
                  }}
                >
                  {a.filename}
                </button>
              ))}
            </div>
          )}
        </span>
      )}
      {sug && <MentionMenu state={sug} keydown={keydown} onClose={() => setSug(null)} />}
    </div>
  );
}
