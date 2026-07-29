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
import { ActiveLineSource, SourceableListItem, SourceBlock } from "../lib/active-line-source.ts";
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
  onFocusChange,
}: {
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  autofocus?: boolean;
  /** Enables image paste/insert (images are stored as block attachments). */
  blockId?: string;
  /** Reports focus/blur so the host can hold live-sync updates while editing. */
  onFocusChange?: (focused: boolean) => void;
}) {
  const [mode, setMode] = useState<Mode>("live");
  const [markdown, setMarkdown] = useState(value);
  const [sug, setSug] = useState<MentionState | null>(null);
  const [extract, setExtract] = useState<
    {
      x: number;
      y: number;
      from: number;
      to: number;
      titleText: string;
      titleRaw: string;
      mdText: string;
      types: BlockType[];
    } | null
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
      // Our ListItem (below) accepts a raw source line as a child so the active
      // list line can show its markdown — disable StarterKit's stock one.
      StarterKit.configure({ listItem: false }),
      SourceableListItem,
      // Allow our custom mention schemes to survive markdown re-parsing (raw→live
      // and reload), so they convert back into mention chips.
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        protocols: ["block", "tag"],
      }),
      TaskList,
      // Same source-line allowance for checklist items.
      TaskItem.extend({
        content() {
          return this.options.nested ? "(paragraph | sourceBlock) block*" : "(paragraph | sourceBlock)+";
        },
      }).configure({ nested: true }),
      // html:false — never parse raw HTML out of markdown into the document.
      // Notes are plain markdown here, so this closes a raw-HTML-injection path
      // (e.g. pasted/imported <img onerror=…>) at no cost to real content.
      Markdown.configure({ html: false, breaks: true, transformPastedText: true }),
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
    onFocus: () => onFocusChange?.(true),
    onBlur: () => onFocusChange?.(false),
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
  // the selection three ways: `titleText` inlines any mention as its plain label
  // (used for the mention that replaces the selection); `titleRaw` keeps mentions
  // in a title field's compact form (`|<id>`, `#tag`, `@Name`) so the new block's
  // title preserves the connections; `mdText` keeps them as `[label](href)` for a
  // text block's body.
  const onContextMenu = (e: React.MouseEvent) => {
    if (!editor || mode !== "live") return;
    const { from, to, empty } = editor.state.selection;
    if (empty) return;
    const doc = editor.state.doc;
    const asLabel = (n: PMNode) => (n.type.name === "mention" ? String(n.attrs.label ?? "") : "");
    const asMarkdown = (n: PMNode) =>
      n.type.name === "mention" ? `[${escapeLabel(String(n.attrs.label ?? ""))}](${n.attrs.href})` : "";
    // A mention in a title is stored raw: tags `#name`, people `@Name`, any other
    // block `|<id>`. Plain web links (no scheme we recognize) fall back to text.
    const asTitleRaw = (n: PMNode) => {
      if (n.type.name !== "mention") return "";
      const href = String(n.attrs.href ?? "");
      const label = String(n.attrs.label ?? "");
      if (href.startsWith("tag:")) return `#${href.slice(4)}`;
      if (href.startsWith("person:")) return `@${href.slice(7).replace(/ /g, "_")}`;
      if (href.startsWith("block:")) return `|${href.slice(6)}`;
      return label;
    };
    const titleText = doc.textBetween(from, to, "\n", asLabel).trim();
    // Titles are single-line — collapse any line breaks in the selection.
    const titleRaw = doc.textBetween(from, to, " ", asTitleRaw).replace(/\s+/g, " ").trim();
    const mdText = doc.textBetween(from, to, "\n", asMarkdown).trim();
    if (!titleText && !mdText) return;
    e.preventDefault();
    void api
      .get<BlockType[]>("/block-types")
      .then((types) => setExtract({ x: e.clientX, y: e.clientY, from, to, titleText, titleRaw, mdText, types }))
      .catch(() => {});
  };

  // Create a new block of `type` from the selection, then replace the selection
  // with a block: mention linking back to it. A typed block's title keeps the
  // selection's mentions inline (so its @/#/| connections survive) — no separate
  // description is populated; a text block keeps the markdown as its body.
  const extractTo = async (type: BlockType) => {
    if (!extract || !editor) return;
    const { from, to, titleText, titleRaw, mdText } = extract;
    setExtract(null);
    const title = titleRaw.trim() || "Untitled";
    const body = type.isText ? { content: mdText } : { properties: { title } };
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
