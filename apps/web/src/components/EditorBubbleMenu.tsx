import type { Editor } from "@tiptap/core";
import { Bold, Code, Italic, Pilcrow, Strikethrough } from "lucide-react";
import { useEffect, useReducer, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Selection toolbar for the live editor: toggle emphasis (bold/italic/strike/
 * code) and set the block's heading level (or paragraph). Everything toggles,
 * so it also removes formatting. Positioned from the selection (no tippy) and
 * driven by editor events, so it unmounts cleanly.
 */
export function EditorBubbleMenu({ editor }: { editor: Editor }) {
  const [, bump] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    editor.on("transaction", bump);
    editor.on("focus", bump);
    editor.on("blur", bump);
    return () => {
      editor.off("transaction", bump);
      editor.off("focus", bump);
      editor.off("blur", bump);
    };
  }, [editor]);

  const sel = editor.state.selection;
  if (sel.empty || !editor.isEditable || !editor.isFocused || editor.isActive("codeBlock")) {
    return null;
  }

  let top = 0;
  let left = 0;
  try {
    const a = editor.view.coordsAtPos(sel.from);
    const b = editor.view.coordsAtPos(sel.to);
    top = Math.min(a.top, b.top);
    left = (a.left + b.left) / 2;
  } catch {
    return null;
  }

  const noBlur = (e: React.MouseEvent) => e.preventDefault();
  const Btn = ({
    on,
    title,
    onClick,
    children,
  }: {
    on: boolean;
    title: string;
    onClick: () => void;
    children: ReactNode;
  }) => (
    <button
      type="button"
      className={`bubble-btn${on ? " active" : ""}`}
      title={title}
      onMouseDown={noBlur}
      onClick={onClick}
    >
      {children}
    </button>
  );

  const style: CSSProperties = {
    position: "fixed",
    top: Math.max(6, top - 44),
    left,
    transform: "translateX(-50%)",
    zIndex: 90,
  };

  return createPortal(
    <div className="edit-bubble" style={style} onMouseDown={noBlur}>
      <Btn on={editor.isActive("bold")} title="Bold (⌘B)" onClick={() => editor.chain().focus().toggleBold().run()}>
        <Bold size={14} />
      </Btn>
      <Btn on={editor.isActive("italic")} title="Italic (⌘I)" onClick={() => editor.chain().focus().toggleItalic().run()}>
        <Italic size={14} />
      </Btn>
      <Btn on={editor.isActive("strike")} title="Strikethrough" onClick={() => editor.chain().focus().toggleStrike().run()}>
        <Strikethrough size={14} />
      </Btn>
      <Btn on={editor.isActive("code")} title="Inline code" onClick={() => editor.chain().focus().toggleCode().run()}>
        <Code size={14} />
      </Btn>
      <span className="bubble-sep" />
      {([1, 2, 3] as const).map((level) => (
        <Btn
          key={level}
          on={editor.isActive("heading", { level })}
          title={`Heading ${level}`}
          onClick={() => editor.chain().focus().toggleHeading({ level }).run()}
        >
          H{level}
        </Btn>
      ))}
      <Btn on={editor.isActive("paragraph")} title="Paragraph" onClick={() => editor.chain().focus().setParagraph().run()}>
        <Pilcrow size={14} />
      </Btn>
    </div>,
    document.body,
  );
}
