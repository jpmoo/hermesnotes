import { bodyFieldKey } from "@hermes/shared";
import { createPortal } from "react-dom";
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
import type { Editor } from "@tiptap/core";
import { caretOffset, isCaretLine, templateName } from "@hermes/shared";
import { ActiveLineSource, SourceableListItem, SourceBlock } from "../lib/active-line-source.ts";
import { CheckboxInput, HeadingIndent, SmartEnter } from "../lib/heading-indent.ts";
import { ListGutter, ListIndent } from "../lib/list-tools.ts";
import { patchMarkdownParser } from "../lib/markdown-fixups.ts";
import type { Node as PMNode } from "@tiptap/pm/model";
import { escapeLabel, linksToMentions, MentionNode } from "../lib/mention-node.ts";
import { Mentions, type MentionHandlers, type MentionState } from "../lib/mentions.ts";
import { captureField, runFieldClipboard, type FieldSelection } from "../lib/field-clipboard.ts";
import { MentionMenu } from "./MentionMenu.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

type Mode = "live" | "raw";

/**
 * Put the caret where the template said to.
 *
 * A template can mark a spot with a line holding nothing but a slash — under
 * a heading, inside a section — so that writing starts where the writing goes
 * rather than at the top or wherever the pointer happened to land. The mark is
 * selected rather than merely passed, so the first keystroke replaces it and
 * the slash never survives into the note.
 */
function placeCaret(editor: Editor, text: string): boolean {
  if (caretOffset(text) == null) return false;
  let found: { from: number; to: number } | null = null;
  editor.state.doc.descendants((n, pos) => {
    if (found || !n.isTextblock) return;
    if (isCaretLine(n.textContent)) found = { from: pos + 1, to: pos + n.nodeSize - 1 };
  });
  if (!found) return false;
  const at = found as { from: number; to: number };
  editor.chain().focus().setTextSelection({ from: at.from, to: at.to }).run();
  return true;
}

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
  periodic = false,
}: {
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  autofocus?: boolean;
  /** Enables image paste/insert (images are stored as block attachments). */
  blockId?: string;
  /** Reports focus/blur so the host can hold live-sync updates while editing. */
  onFocusChange?: (focused: boolean) => void;
  /** A daily scratchpad or weekly reflection: text here can be sent forward
   *  into the next one, so the right-click menu offers it. */
  periodic?: boolean;
}) {
  const [mode, setMode] = useState<Mode>("live");
  const [markdown, setMarkdown] = useState(value);
  // The current text, readable from callbacks that were made once.
  const markdownRef = useRef(value);
  markdownRef.current = markdown;
  // Whether this visit has already been sent to the template's mark.
  const landed = useRef(false);
  const [sug, setSug] = useState<MentionState | null>(null);
  // Templates offered in the right-click menu, and the one waiting on a
  // yes/no because this field already has something in it.
  const [templates, setTemplates] = useState<Block[]>([]);
  const [pendingTemplate, setPendingTemplate] = useState<Block | null>(null);
  const [extract, setExtract] = useState<
    {
      x: number;
      y: number;
      from: number;
      to: number;
      titleText: string;
      titleRaw: string;
      field: FieldSelection | null;
      /** The forwarded run the click landed in, if any. */
      inForward: { from: number; to: number } | null;
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
      // tiptap-markdown marks lists "tight" (items on consecutive lines) via a
      // global attribute, but only registers it for bulletList and orderedList —
      // so a checklist serialized loose, putting a blank line between every item
      // in the raw markdown. Carry the same attribute here.
      TaskList.extend({
        addAttributes() {
          return {
            ...this.parent?.(),
            tight: {
              default: true,
              parseHTML: (el) => el.getAttribute("data-tight") !== "false",
              renderHTML: (attrs) => (attrs.tight ? { "data-tight": "true" } : {}),
            },
          };
        },
      }),
      // Same source-line allowance for checklist items.
      TaskItem.extend({
        content() {
          return this.options.nested ? "(paragraph | sourceBlock) block*" : "(paragraph | sourceBlock)+";
        },
      }).configure({ nested: true }),
      // Keep html:true (the default): with it off, tiptap-markdown escapes any
      // literal HTML in a note on every parse/serialize cycle, which destabilizes
      // the live-preview round-trip for notes that contain markup. Raw-HTML XSS is
      // already contained by the CSP (script-src 'self', no inline) — not worth
      // trading content fidelity for.
      // transformCopiedText: the plain-text flavour on the clipboard is the note's
      // markdown, so pasting into another app carries `- [ ]` and emphasis rather
      // than a flattened line, and pasting back in re-parses to the real thing.
      Markdown.configure({ breaks: true, transformPastedText: true, transformCopiedText: true }),
      Placeholder.configure({ placeholder }),
      CheckboxInput,
      SmartEnter,
      HeadingIndent,
      MentionNode,
      MdImage,
      SourceBlock,
      ActiveLineSource,
      ListIndent,
      ListGutter,
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
    onFocus: ({ editor: ed }) => {
      onFocusChange?.(true);
      if (landed.current) return;
      landed.current = true;
      // After the click has finished setting its own selection.
      requestAnimationFrame(() => placeCaret(ed as Editor, markdownRef.current));
    },
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
  // The list is small and rarely changes; fetched once so the menu can open
  // without a wait.
  useEffect(() => {
    void api.get<Block[]>("/templates").then(setTemplates).catch(() => {});
  }, []);

  /**
   * Put a template's text in this field. Replacing what's there is the whole
   * point when a field is empty and a serious thing to do when it isn't, so
   * the second case asks first.
   */
  const applyTemplate = (tpl: Block, confirmed = false) => {
    if (!editor) return;
    const body = tpl.content ?? "";
    const existing = editor.getText().trim();
    if (existing && !confirmed) {
      setPendingTemplate(tpl);
      return;
    }
    setPendingTemplate(null);
    setExtract(null);
    editor.commands.setContent(body);
    setMarkdown(body);
    onChange(body);
    // Straight to the spot the template marked, if it marked one.
    placeCaret(editor, body);
  };

  const onContextMenu = (e: React.MouseEvent) => {
    if (!editor || mode !== "live") return;
    const { from, to, empty } = editor.state.selection;
    if (empty) {
      // No selection: the only thing on offer is a template, and only when
      // there are any.
      if (templates.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      void api
        .get<BlockType[]>("/block-types")
        .then((types) =>
          setExtract({
            x: e.clientX,
            y: e.clientY,
            from,
            to,
            titleText: "",
            titleRaw: "",
            mdText: "",
            field: captureField(e.target),
            inForward: null,
            types,
          }),
        )
        .catch(() => {});
      return;
    }
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
    // One menu, not two: inside a canvas node this event would otherwise also
    // reach the node, which answers right-clicks with a menu of its own.
    e.stopPropagation();
    const field = captureField(e.target);
    // Anywhere inside a forwarded run counts as clicking it: the reader
    // shouldn't have to find its exact edges to stop it.
    let inForward: { from: number; to: number } | null = null;
    doc.descendants((n, pos) => {
      if (n.type.name !== "mention") return;
      if (!String(n.attrs.href ?? "").startsWith("fwd:")) return;
      if (pos < to && pos + n.nodeSize > from) inForward = { from: pos, to: pos + n.nodeSize };
    });
    void api
      .get<BlockType[]>("/block-types")
      .then((types) =>
        setExtract({
          x: e.clientX,
          y: e.clientY,
          from,
          to,
          titleText,
          titleRaw,
          mdText,
          field,
          inForward,
          types,
        }),
      )
      .catch(() => {});
  };

  /**
   * Send the selection forward: mark it, and it's copied into the next daily
   * note (or weekly reflection) as that note is made, and the one after that,
   * for as long as it's still marked. The moment is recorded because several
   * pieces travelling together read in the order they were first sent.
   */
  const sendForward = () => {
    if (!extract || !editor) return;
    const { from, to, titleText } = extract;
    setExtract(null);
    const mention = editor.state.schema.nodes.mention;
    if (!mention || !titleText.trim()) return;
    const node = mention.create({
      href: `fwd:${encodeURIComponent(new Date().toISOString())}`,
      label: titleText.trim(),
    });
    editor.view.dispatch(editor.state.tr.replaceWith(from, to, node));
    editor.view.focus();
  };

  /** Stop sending it forward — here and from here on. What earlier notes
   *  already carry is theirs, and stays as they were written. */
  const stopForward = () => {
    if (!extract || !editor || !extract.inForward) return;
    const { from, to } = extract.inForward;
    setExtract(null);
    const node = editor.state.doc.nodeAt(from);
    const text = String(node?.attrs.label ?? "");
    editor.view.dispatch(
      text
        ? editor.state.tr.replaceWith(from, to, editor.state.schema.text(text))
        : editor.state.tr.delete(from, to),
    );
    editor.view.focus();
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
    // Everything below the first line is the selection's body. A typed block
    // took the title and dropped the rest, so extracting a paragraph into a task
    // kept its first line and threw the paragraph away.
    const rest = mdText.slice(mdText.split("\n")[0]?.length ?? 0).replace(/^\n+/, "");
    const key = bodyFieldKey(type.propertySchema);
    const body = type.isText
      ? { content: mdText }
      : {
          properties: { title, ...(rest && key ? { [key]: rest } : {}) },
          // Nowhere to put prose on this type: keep it on the block rather than
          // losing it on the way through.
          ...(rest && !key ? { content: rest } : {}),
        };
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

      {/* Out to the body: "fixed" is measured against the nearest transformed
          ancestor, not the window, and a canvas node lives inside a layer that
          pans and zooms by transform — so a popup positioned at window
          coordinates landed a screen away from the field that opened it, at the
          wrong scale. Nothing else needs to know; the coordinates are already
          the right ones. */}
      {extract &&
        createPortal(
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
          {extract.field && (
            <>
              {(["Cut", "Copy", "Paste"] as const).map((label) => (
                <button
                  key={label}
                  className="menu-item"
                  onClick={() => {
                    const f = extract.field;
                    setExtract(null);
                    if (f) void runFieldClipboard(f, label.toLowerCase() as "cut" | "copy" | "paste");
                  }}
                >
                  {label}
                </button>
              ))}
              <div className="menu-sep" />
            </>
          )}
          {templates.length > 0 && (
            <>
              <div className="hint" style={{ padding: "6px 10px" }}>
                Apply a template
              </div>
              {templates.map((t) => (
                <button
                  key={t.id}
                  className="menu-item"
                  onClick={() => applyTemplate(t)}
                >
                  {templateName(t.properties) || "Untitled"}
                </button>
              ))}
              {(extract.titleText.trim() || extract.inForward) && <div className="menu-sep" />}
            </>
          )}
          {periodic && (extract.inForward || extract.titleText.trim()) && (
            <>
              {extract.inForward ? (
                <button className="menu-item" onClick={stopForward}>
                  Stop sending this text forward
                </button>
              ) : (
                <button className="menu-item" onClick={sendForward}>
                  Send this text forward
                </button>
              )}
              <div className="menu-sep" />
            </>
          )}
          {extract.titleText.trim() && (
            <div className="hint" style={{ padding: "6px 10px" }}>
              Extract selection to a new…
            </div>
          )}
          {extract.titleText.trim() &&
            [...extract.types]
              .sort((a, b) => (a.isText === b.isText ? a.name.localeCompare(b.name) : a.isText ? -1 : 1))
              .map((t) => (
                <button key={t.id} className="menu-item type-item" onClick={() => void extractTo(t)}>
                  <BlockIcon
                    iconKey={t.isText ? "type" : t.iconKey}
                    color={t.isText ? null : t.iconColor}
                    size={16}
                  />
                  <span style={{ textTransform: "capitalize" }}>{t.name}</span>
                </button>
              ))}
          </div>,
          document.body,
        )}
      <ConfirmDialog
        open={pendingTemplate !== null}
        title={`Replace what's here with “${templateName(pendingTemplate?.properties) || "this template"}”?`}
        message="This field already has something in it. Applying a template replaces all of it, and there's no undo."
        confirmLabel="Replace"
        danger
        onCancel={() => setPendingTemplate(null)}
        onConfirm={() => pendingTemplate && applyTemplate(pendingTemplate, true)}
      />
    </div>
  );
}
