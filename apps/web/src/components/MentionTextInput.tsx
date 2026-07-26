import { Extension, type JSONContent } from "@tiptap/core";
import Placeholder from "@tiptap/extension-placeholder";
import type { Node as PMNode } from "@tiptap/pm/model";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useMemo, useRef, useState } from "react";
import { MentionNode } from "../lib/mention-node.ts";
import { Mentions, type MentionHandlers, type MentionState } from "../lib/mentions.ts";
import { MentionMenu } from "./MentionMenu.tsx";

/**
 * A single-line, mention-aware replacement for a plain text <input>: typing
 * `@` / `#` / `|` opens the same dynamic search dropdown as the note editors,
 * and picked items render as chips. Unlike the markdown editors, the stored
 * value keeps the RAW compact forms — `#tag`, `@Name_With_Underscores`,
 * `|<block-id>` — which the server scans for tag sync and connections.
 */

const RAW_RE = /#([A-Za-z0-9][\w-]*)|@([A-Za-z0-9][\w-]*)|\|([0-9a-fA-F-]{36})/g;

/** Parse a stored line into paragraph content (text runs + mention chips). */
function parseLine(value: string): JSONContent[] {
  const parts: JSONContent[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  RAW_RE.lastIndex = 0;
  while ((m = RAW_RE.exec(value)) !== null) {
    if (m.index > last) parts.push({ type: "text", text: value.slice(last, m.index) });
    if (m[1]) parts.push({ type: "mention", attrs: { label: `#${m[1]}`, href: `tag:${m[1].toLowerCase()}` } });
    else if (m[2])
      parts.push({ type: "mention", attrs: { label: m[2].replace(/_/g, " "), href: `person:${m[2]}` } });
    else if (m[3]) parts.push({ type: "mention", attrs: { label: "", href: `block:${m[3]}` } });
    last = m.index + m[0].length;
  }
  if (last < value.length) parts.push({ type: "text", text: value.slice(last) });
  return [{ type: "paragraph", ...(parts.length ? { content: parts } : {}) }];
}

/** Serialize a mention chip back to its raw form. */
function rawOf(href: string, label: string): string {
  if (href.startsWith("tag:")) return `#${href.slice(4)}`;
  if (href.startsWith("person:")) return `@${href.slice(7)}`;
  if (href.startsWith("block:")) return `|${href.slice(6)}`;
  return label;
}

/** Serialize the doc back to the stored string (paragraph breaks → spaces). */
function serializeLine(doc: PMNode): string {
  const chunks: string[] = [];
  doc.forEach((para) => {
    let line = "";
    para.descendants((n) => {
      if (n.isText) line += n.text ?? "";
      else if (n.type.name === "mention") line += rawOf(String(n.attrs.href), String(n.attrs.label));
      return true;
    });
    chunks.push(line);
  });
  return chunks.join(" ").replace(/\s+/g, " ").trimEnd();
}

/** Swallow Enter (single-line field); blur instead, like pressing Tab. */
const SingleLine = Extension.create({
  name: "singleLine",
  priority: 1001,
  addKeyboardShortcuts() {
    return {
      Enter: () => {
        this.editor.commands.blur();
        return true;
      },
      "Shift-Enter": () => true,
      "Mod-Enter": () => true,
    };
  },
});

export function MentionTextInput({
  value,
  onChange,
  placeholder,
  className,
  onFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  onFocus?: () => void;
}) {
  const [sug, setSug] = useState<MentionState | null>(null);
  const keydown = useRef<((e: KeyboardEvent) => boolean) | null>(null);
  const lastEmit = useRef(value);

  // `@` picks are stored by NAME (raw `@Name` form), so rewrite their href
  // from block:<id> to person:<name> before the chip is inserted.
  const wrap = (s: MentionState): MentionState =>
    s.char === "@"
      ? {
          ...s,
          select: (item) =>
            s.select({ label: item.label, href: `person:${item.label.replace(/ /g, "_")}` }),
        }
      : s;
  const handlers = useMemo<MentionHandlers>(
    () => ({
      onOpen: (s) => setSug(wrap(s)),
      onUpdate: (s) => setSug(wrap(s)),
      onClose: () => setSug(null),
      keydown,
    }),
    [],
  );

  const editor = useEditor({
    extensions: [
      // Nodes only — no marks, lists, or headings; `#`/`-` etc. stay literal.
      StarterKit.configure({
        heading: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        blockquote: false,
        codeBlock: false,
        code: false,
        bold: false,
        italic: false,
        strike: false,
        horizontalRule: false,
        hardBreak: false,
      }),
      SingleLine,
      Placeholder.configure({ placeholder: placeholder ?? "" }),
      MentionNode,
      Mentions.configure({ handlers }),
    ],
    content: { type: "doc", content: parseLine(value) },
    // Suppress browser / password-manager autofill dropdowns on the editable.
    editorProps: {
      attributes: {
        class: "mention-line",
        autocomplete: "off",
        autocorrect: "off",
        autocapitalize: "off",
        "data-1p-ignore": "true",
        "data-lpignore": "true",
      },
    },
    onFocus: () => onFocus?.(),
    onUpdate: ({ editor }) => {
      const s = serializeLine(editor.state.doc);
      if (s === lastEmit.current) return;
      lastEmit.current = s;
      onChange(s);
    },
  });

  // External value change (reload, conflict refresh) → re-render the line.
  useEffect(() => {
    if (!editor || value === lastEmit.current) return;
    lastEmit.current = value;
    editor.commands.setContent({ type: "doc", content: parseLine(value) }, false);
  }, [value, editor]);

  return (
    <div className={`mention-input${className ? ` ${className}` : ""}`}>
      <EditorContent editor={editor} />
      {sug && <MentionMenu state={sug} keydown={keydown} onClose={() => setSug(null)} />}
    </div>
  );
}
