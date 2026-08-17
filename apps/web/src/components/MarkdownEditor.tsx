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
import { getMarkRange, type Editor } from "@tiptap/core";
import {
  caretOffset,
  DAILY_TEMPLATE_PREF,
  isCaretLine,
  templateName,
  WEEKLY_TEMPLATE_PREF,
} from "@hermes/shared";
import { ActiveLineSource, SourceableListItem, SourceBlock } from "../lib/active-line-source.ts";
import { CheckboxInput, HeadingIndent, SmartEnter } from "../lib/heading-indent.ts";
import { ListGutter, ListIndent } from "../lib/list-tools.ts";
import { patchMarkdownParser } from "../lib/markdown-fixups.ts";
import type { Node as PMNode } from "@tiptap/pm/model";
import { CaretSlot } from "../lib/caret-slot.ts";
import { ForwardMark } from "../lib/forward-mark.ts";
import { escapeLabel, linksToMentions, MentionNode } from "../lib/mention-node.ts";
import { Mentions, type MentionHandlers, type MentionState } from "../lib/mentions.ts";
import { captureField, runFieldClipboard, type FieldSelection } from "../lib/field-clipboard.ts";
import { useMenuPosition } from "../lib/menu-position.ts";
import { emitBlockChange } from "../lib/block-events.ts";
import { MentionMenu } from "./MentionMenu.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { SendToDaysModal } from "./SendToDaysModal.tsx";

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

/** A date as this browser reckons it, which is the only clock that knows what
 *  day it is where the reader is sitting. */
function ymdLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
  periodicKind = null,
  periodicDate = null,
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
   *  into the next one, and a template can be made the shape they all take. */
  periodicKind?: "daily" | "weekly" | null;
  /** The day (or week) this note belongs to, YYYY-MM-DD. Stamped on text sent
   *  to other days, so a piece that turns up on Tuesday says where it's from. */
  periodicDate?: string | null;
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
  const [pendingForever, setPendingForever] = useState<Block | null>(null);
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
  // Keeps the right-click menu on screen whole — down-right of the pointer
  // where there's room, flipped back over it where there isn't.
  const [menuRef, menuStyle] = useMenuPosition(extract?.x ?? 0, extract?.y ?? 0);
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
        // Every scheme a mention can carry has to be listed here, or the link
        // extension refuses it on parse and drops the mark — the text stays,
        // the connection doesn't, and the next save writes the loss back. That
        // silently unmade placeholders and sent-forward text on every reload.
        protocols: ["block", "tag", "person", "new", "fwd"],
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
      ForwardMark,
      CaretSlot,
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

  /**
   * Make this the shape every note of this kind takes from now on. Only the
   * ones not yet made: a note already written in is somebody's writing, and
   * a template is not worth overwriting it for.
   */
  const useForever = (tpl: Block) => {
    setPendingForever(null);
    setExtract(null);
    const key = periodicKind === "weekly" ? WEEKLY_TEMPLATE_PREF : DAILY_TEMPLATE_PREF;
    void api.patch("/settings/preferences", { [key]: tpl.id }).catch(() => {});
    applyTemplate(tpl, editor?.getText().trim() === "");
  };

  /** A range as it reads — mentions by name, no markdown around the words. It's
   *  what copies of this text are matched on, wherever they ended up and by
   *  whichever route they got there. */
  const rangeText = (doc: PMNode, from: number, to: number) =>
    doc
      .textBetween(from, to, "\n", (n) =>
        n.type.name === "mention" ? String(n.attrs.label ?? "") : "",
      )
      .trim();

  /** The marked run covering (or touching) a position, if there is one. */
  const forwardAround = (doc: PMNode, from: number, to: number) => {
    let found: { from: number; to: number } | null = null;
    doc.descendants((n, pos) => {
      if (found || !n.isInline) return;
      if (!n.marks.some((mk) => mk.type.name === "forwarded")) return;
      if (pos <= to && pos + n.nodeSize >= from) {
        // The mark may run across several inline nodes; take the whole run.
        const range = getMarkRange(doc.resolve(pos + 1), n.marks.find((mk) => mk.type.name === "forwarded")!.type);
        found = range ? { from: range.from, to: range.to } : { from: pos, to: pos + n.nodeSize };
      }
    });
    return found;
  };

  const onContextMenu = (e: React.MouseEvent) => {
    if (!editor || mode !== "live") return;
    const { from, to, empty } = editor.state.selection;
    if (empty) {
      // No selection, but the click may still have landed on marked text —
      // finding the ends of a highlight to select them is not something
      // anyone should have to do to stop it.
      // Where the pointer actually is, not where the caret happens to be: a
      // right-click doesn't always move the selection, and "anywhere inside the
      // highlight" has to mean anywhere.
      const at = editor.view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos;
      const here = forwardAround(editor.state.doc, at ?? from, at ?? to);
      if (templates.length === 0 && !here) return;
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
            inForward: here,
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
    // Anywhere inside a marked run counts as clicking it: the reader
    // shouldn't have to find its exact edges to stop it.
    const atSel = editor.view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos;
    const inForward = forwardAround(doc, atSel ?? from, atSel ?? to) ?? forwardAround(doc, from, to);
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
    const { from, to } = range.current ?? extract;
    const { titleText } = extract;
    setExtract(null);
    if (!titleText.trim()) return;
    editor
      .chain()
      .focus()
      .setTextSelection({ from, to })
      .setMark("forwarded", { since: new Date().toISOString() })
      .run();
  };

  /**
   * Send it to days you choose instead of to every day from here. The text goes
   * as markdown, so a mention in it arrives as a mention; nothing changes in
   * this note, because this is a copy leaving rather than a mark being set.
   */
  const [sendTo, setSendTo] = useState<string | null>(null);
  // How many days it went to, said briefly and then gone. Sending is otherwise
  // invisible from here: the note it left doesn't change.
  const [sentNote, setSentNote] = useState<number | null>(null);
  // …and how many days it was taken back out of, said the same way.
  const [retractNote, setRetractNote] = useState<number | null>(null);
  /** Something the reader asked for didn't happen, said where they're looking. */
  const [failNote, setFailNote] = useState<string | null>(null);
  useEffect(() => {
    if (sentNote === null && retractNote === null && failNote === null) return;
    const t = setTimeout(() => {
      setSentNote(null);
      setRetractNote(null);
      setFailNote(null);
    }, 4000);
    return () => clearTimeout(t);
  }, [sentNote, retractNote, failNote]);
  const openSendTo = () => {
    if (!extract) return;
    const md = extract.mdText.trim();
    setExtract(null);
    if (md) setSendTo(md);
  };

  /**
   * What to do with a copy in front of you. All three leave earlier notes
   * alone: what you wrote on Tuesday is what you wrote on Tuesday.
   *
   *  - stop:       keep the words here, unmarked, and clear the days ahead.
   *  - remove:     take the words out here, and clear the days ahead.
   *  - removeHere: take the words out here and touch nothing else — for a copy
   *                that's simply had its day, where the thing itself is still
   *                worth meeting on the days it's already been given to.
   *
   * "Clear the days ahead" is the difference between the middle one and the
   * last, and it's the whole reason there are three: a copy already sitting in
   * a day that hasn't happened is either something you're done with or
   * something you still want waiting there, and only you know which.
   */
  const stopForward = (mode: "stop" | "remove" | "removeHere") => {
    if (!extract || !editor || !extract.inForward) return;
    const { from, to } = range.current?.inForward ?? extract.inForward;
    const md = rangeText(editor.state.doc, from, to);
    setExtract(null);
    // deleteRange, not select-then-deleteSelection: a chained deleteSelection
    // reads the selection off the original state, not off the transaction the
    // chain is building — so with the caret sitting where the right-click left
    // it, there was nothing selected and it deleted nothing at all. unsetMark
    // does use the chain's own selection, which is why the other one worked.
    if (mode === "stop") {
      editor.chain().focus().setTextSelection({ from, to }).unsetMark("forwarded").run();
    } else {
      editor.chain().focus().deleteRange({ from, to }).run();
    }
    if (mode === "removeHere" || !periodicDate || !md) return;
    // The floor is this browser's idea of today, not the server's: only one of
    // them knows what day it is where the reader is.
    const now = ymdLocal(new Date());
    void api
      .post<{ cleared: string[] }>("/today/retract", {
        text: md,
        after: periodicDate > now ? periodicDate : now,
      })
      .then((r) => {
        if (r.cleared.length) setRetractNote(r.cleared.length);
        for (const id of r.cleared) emitBlockChange(id, "retract");
      })
      .catch(() => {});
  };

  // Create a new block of `type` from the selection, then replace the selection
  // with a block: mention linking back to it. A typed block's title keeps the
  // selection's mentions inline (so its @/#/| connections survive) — no separate
  // description is populated; a text block keeps the markdown as its body.
  const extractTo = async (type: BlockType) => {
    if (!extract || !editor) return;
    const { from, to } = range.current ?? extract;
    const { titleText, titleRaw, mdText } = extract;
    setExtract(null);
    // Checked before the block is made, not after: this used to create the
    // block and then throw on the way to linking it, leaving one behind with
    // nothing pointing at it and no word of what happened.
    if (from < 0 || to > editor.state.doc.content.size || from > to) {
      console.error("extract: the selection moved out from under the menu", { from, to });
      setFailNote("That selection has moved — try again.");
      return;
    }
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
      if (!mention) throw new Error("no mention node in this editor's schema");
      const tr = editor.state.tr.replaceWith(from, to, mention.create({ href: `block:${b.id}`, label: titleText }));
      editor.view.dispatch(tr);
      editor.view.focus();
    } catch (err) {
      // The menu is already gone by now, so a swallowed failure here was
      // indistinguishable from the command doing nothing at all — the words
      // stayed put and nothing said why. Say so, and leave the reason in the
      // console for whoever goes looking.
      console.error("extract to a new block failed", err);
      setFailNote(`Couldn't make that ${type.name.toLowerCase()}.`);
    }
  };

  /**
   * The menu's range, kept true to the document while the menu is open.
   *
   * Choosing an item blurs the editor, and an unfocused note renders every line
   * that was showing its raw markdown (see ActiveLineSource) — which replaces
   * those nodes and shifts everything after them. The numbers captured when the
   * menu opened then point at the wrong text, or past the end of the document,
   * and the command either lands somewhere else or throws.
   *
   * Mapping through each transaction is exact here rather than approximate: a
   * line is never sourced while a selection is live, so the change is always
   * outside the range this is holding, never inside it.
   */
  const range = useRef<{ from: number; to: number; inForward: { from: number; to: number } | null } | null>(null);
  useEffect(() => {
    range.current = extract
      ? { from: extract.from, to: extract.to, inForward: extract.inForward }
      : null;
  }, [extract]);
  useEffect(() => {
    if (!editor) return;
    const onTransaction = ({ transaction }: { transaction: { docChanged: boolean; mapping: { map: (p: number) => number } } }) => {
      const r = range.current;
      if (!r || !transaction.docChanged) return;
      const m = transaction.mapping;
      range.current = {
        from: m.map(r.from),
        to: m.map(r.to),
        inForward: r.inForward
          ? { from: m.map(r.inForward.from), to: m.map(r.inForward.to) }
          : null,
      };
    };
    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
    };
  }, [editor]);

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
            ref={menuRef}
            className="menu extract-menu"
            // Placed by measurement rather than by a fixed height: this menu
            // carries whatever the thing under the pointer offers, so it can be
            // any height, and it used to cap itself at 320px and scroll. On
            // macOS the scrollbar is an overlay that only appears while you're
            // scrolling, so there was nothing to say the rest was down there —
            // the last thing visible was a grey heading, and the commands under
            // it may as well not have existed.
            style={{ ...menuStyle, zIndex: 1000 }}
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
                  {periodicKind && <span className="hint"> · just this one</span>}
                </button>
              ))}
              {periodicKind &&
                templates.map((t) => (
                  <button
                    key={`fwd-${t.id}`}
                    className="menu-item"
                    onClick={() => setPendingForever(t)}
                  >
                    {templateName(t.properties) || "Untitled"}
                    <span className="hint">
                      {" "}· this and all future{" "}
                      {periodicKind === "weekly" ? "reflections" : "days"}
                    </span>
                  </button>
                ))}
              {(extract.titleText.trim() || extract.inForward) && <div className="menu-sep" />}
            </>
          )}
          {periodicKind && (extract.inForward || extract.titleText.trim()) && (
            <>
              {extract.inForward ? (
                <>
                  <button className="menu-item" onClick={() => stopForward("stop")}>
                    Stop sending this text forward
                  </button>
                  <button className="menu-item" onClick={() => stopForward("remove")}>
                    Remove it here and stop sending it forward
                  </button>
                  <button className="menu-item" onClick={() => stopForward("removeHere")}>
                    Remove from here only
                  </button>
                </>
              ) : (
                <button className="menu-item" onClick={sendForward}>
                  Send this text forward
                </button>
              )}
              {periodicDate && extract.mdText.trim() && (
                <button className="menu-item" onClick={openSendTo}>
                  Send this text to particular days…
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
      <ConfirmDialog
        open={pendingForever !== null}
        title={`Start every ${periodicKind === "weekly" ? "weekly reflection" : "daily note"} with “${
          templateName(pendingForever?.properties) || "this template"
        }”?`}
        message={
          "Every one made from now on opens with it, and this one takes it now — replacing " +
          "what's here if there's anything. Notes already written stay as they are."
        }
        confirmLabel="Use for all future"
        danger
        onCancel={() => setPendingForever(null)}
        onConfirm={() => pendingForever && useForever(pendingForever)}
      />
      {sendTo !== null && periodicDate && (
        <SendToDaysModal
          text={sendTo}
          from={periodicDate}
          onClose={() => setSendTo(null)}
          onSent={(days) => setSentNote(days.length)}
        />
      )}
      {sentNote !== null && (
        <div className="editor-toast" role="status">
          Sent to {sentNote} day{sentNote === 1 ? "" : "s"}.
        </div>
      )}
      {retractNote !== null && (
        <div className="editor-toast" role="status">
          Taken back out of {retractNote} day{retractNote === 1 ? "" : "s"} ahead.
        </div>
      )}
      {failNote !== null && (
        <div className="editor-toast editor-toast-bad" role="alert">
          {failNote}
        </div>
      )}
    </div>
  );
}
