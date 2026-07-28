import type { Block, BlockType } from "../api.ts";
import { TextBlockEditor } from "./TextBlockEditor.tsx";
import { TypedBlockCard } from "./TypedBlockCard.tsx";

/** Render a block as a full editable card — typed schema form or text editor. */
export function BlockCard({
  block,
  type,
  onConflict,
  onDeleted,
  compact = false,
  textCollapsed,
  archived = false,
}: {
  block: Block;
  type: BlockType | undefined;
  onConflict: () => void;
  onDeleted: (id: string) => void;
  compact?: boolean;
  /** Text notes: show the one-line preview only when actually collapsed —
   * masonry's compact flag alone keeps the full body visible. */
  textCollapsed?: boolean;
  /** Archive view: cards offer Unarchive + permanent Delete instead of Archive. */
  archived?: boolean;
}) {
  if (type && !type.isText) {
    return (
      <TypedBlockCard
        block={block}
        type={type}
        onConflict={onConflict}
        onDeleted={onDeleted}
        compact={compact}
        archived={archived}
      />
    );
  }
  // Daily notes and weekly-review reflections are system blocks: no banner, and
  // not archivable/deletable (they'd be recreated, and they're managed elsewhere).
  const props = block.properties ?? {};
  const systemNote = props.today_note != null || props.review_reflection != null;
  return (
    <TextBlockEditor
      block={block}
      type={type}
      onConflict={onConflict}
      onDeleted={onDeleted}
      compact={textCollapsed ?? compact}
      archived={archived}
      hideBanner={systemNote}
      canDelete={!systemNote}
    />
  );
}
