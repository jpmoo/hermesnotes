import type { Editor } from "@tiptap/core";
import { BubbleMenu } from "@tiptap/react";
import { Bold, Code, Italic, Pilcrow, Strikethrough } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Selection toolbar for the live editor: toggle emphasis (bold/italic/strike/
 * code) and set the block's heading level (or back to paragraph). Everything
 * toggles, so it also removes formatting.
 */
export function EditorBubbleMenu({ editor }: { editor: Editor }) {
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

  return (
    <BubbleMenu editor={editor} tippyOptions={{ duration: 100 }} className="edit-bubble">
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
      <Btn
        on={editor.isActive("paragraph")}
        title="Paragraph"
        onClick={() => editor.chain().focus().setParagraph().run()}
      >
        <Pilcrow size={14} />
      </Btn>
    </BubbleMenu>
  );
}
