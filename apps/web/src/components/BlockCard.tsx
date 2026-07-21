import type { Block, BlockType } from "../api.ts";
import { TextBlockEditor } from "./TextBlockEditor.tsx";
import { TypedBlockCard } from "./TypedBlockCard.tsx";

/** Render a block as a full editable card — typed schema form or text editor. */
export function BlockCard({
  block,
  type,
  onConflict,
  onDeleted,
}: {
  block: Block;
  type: BlockType | undefined;
  onConflict: () => void;
  onDeleted: (id: string) => void;
}) {
  if (type && !type.isText) {
    return <TypedBlockCard block={block} type={type} onConflict={onConflict} onDeleted={onDeleted} />;
  }
  return <TextBlockEditor block={block} type={type} onConflict={onConflict} onDeleted={onDeleted} />;
}
