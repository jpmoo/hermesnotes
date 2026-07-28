import { Image as ImageIcon } from "lucide-react";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { EditorContent, useEditor } from "@tiptap/react";
import { api, type Attachment, type Block, type BlockType } from "../api.ts";
import { BlockIcon } from "../lib/icons.tsx";
import { IMG_SMALL, MdImage } from "../lib/image-node.ts";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "tiptap-markdown";
import { ActiveLineSource, SourceBlock } from "../lib/active-line-source.ts";
import { CheckboxInput, HeadingIndent, SmartEnter } from "../lib/heading-indent.ts";
import { patchMarkdownParser } from "../lib/markdown-fixups.ts";
import type { Node as PMNode } from "@tiptap/pm/model";
import { escapeLabel, linksToMentions, MentionNode } from "../lib/mention-node.ts";
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
  const [extract, setExtract] = useState<
    { x: number; y: number; from: number; to: number; titleText: string; mdText: string; types: BlockType[] } | null
  >(null);
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
      attributes: {
        class: "note-editor",
        autocomplete: "off",
        autocorrect: "off",
        autocapitalize: "off",
        "data-1p-ignore": "true",
        "data-lpignore": "true",
      },
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
                width: IMG_SMALL,
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

  // Right-click on a selection → offer to extract it into a new block. We read
  // the selection twice: `titleText` inlines any mention/link as its plain label
  // (for a clean title), while `mdText` keeps the link as `[label](href)` so the
  // extracted block's body preserves the connection.
  const onContextMenu = (e: React.MouseEvent) => {
    if (!editor || mode !== "live") return;
    const { from, to, empty } = editor.state.selection;
    if (empty) return;
    const doc = editor.state.doc;
    const asLabel = (n: PMNode) => (n.type.name === "mention" ? String(n.attrs.label ?? "") : "");
    const asMarkdown = (n: PMNode) =>
      n.type.name === "mention" ? `[${escapeLabel(String(n.attrs.label ?? ""))}](${n.attrs.href})` : "";
    const titleText = doc.textBetween(from, to, "\n", asLabel).trim();
    const mdText = doc.textBetween(from, to, "\n", asMarkdown).trim();
    if (!titleText && !mdText) return;
    e.preventDefault();
    void api
      .get<BlockType[]>("/block-types")
      .then((types) => setExtract({ x: e.clientX, y: e.clientY, from, to, titleText, mdText, types }))
      .catch(() => {});
  };

  // Create a new block of `type` from the selection, then replace the selection
  // with a block: mention linking back to it. The new block's title is the
  // link-free label text; its body keeps the original links so any connections
  // in the selection survive on the new block too.
  const extractTo = async (type: BlockType) => {
    if (!extract || !editor) return;
    const { from, to, titleText, mdText } = extract;
    setExtract(null);
    const firstLine = titleText.split("\n")[0]!.trim() || "Untitled";
    const hasDescription = type.propertySchema?.fields.some((f) => f.key === "description");
    const body = type.isText
      ? { content: mdText }
      : { properties: hasDescription ? { title: firstLine, description: mdText } : { title: firstLine } };
    try {
      const b = await api.post<Block>("/blocks", { blockTypeId: type.id, ...body });
      const mention = editor.state.schema.nodes.mention;
      if (!mention) return;
      const tr = editor.state.tr.replaceWith(from, to, mention.create({ href: `block:${b.id}`, label: titleText }));
      editor.view.dispatch(tr);
      editor.view.focus();
    } catch {
      /* creation failed; selection left untouched */
    }
  };

  useEffect(() => {
    if (!extract) return;
    const close = () => setExtract(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setExtract(null);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [extract]);

  return (
    <div className="md-editor">
      {mode === "live" ? (
        <div onContextMenu={onContextMenu}>
          <EditorContent editor={editor} />
        </div>
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
                        attrs: {
                          src: `attachment:${a.id}`,
                          alt: a.filename.replace(/\.[a-z0-9]+$/i, ""),
                          width: IMG_SMALL,
                        },
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

      {extract && (
        <div
          className="menu extract-menu"
          style={{
            position: "fixed",
            left: extract.x,
            top: extract.y,
            right: "auto",
            bottom: "auto",
            zIndex: 1000,
            maxHeight: 320,
            overflowY: "auto",
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="hint" style={{ padding: "6px 10px" }}>
            Extract selection to a new…
          </div>
          {[...extract.types]
            .sort((a, b) => (a.isText === b.isText ? a.name.localeCompare(b.name) : a.isText ? -1 : 1))
            .map((t) => (
              <button key={t.id} className="menu-item type-item" onClick={() => void extractTo(t)}>
                <BlockIcon iconKey={t.isText ? "type" : t.iconKey} color={t.isText ? null : t.iconColor} size={16} />
                <span style={{ textTransform: "capitalize" }}>{t.name}</span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
