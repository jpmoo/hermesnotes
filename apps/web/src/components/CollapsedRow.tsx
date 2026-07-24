import type { Block, BlockType } from "../api.ts";
import { oneLineText } from "../lib/display.ts";
import { BlockIcon } from "../lib/icons.tsx";
import { usePanels } from "../lib/right-panel.tsx";

/** A collapsed block in list (block) view: icon + title on one line. Clicking
 * selects it into the info panel (where it can still be edited). */
export function CollapsedRow({ block, type }: { block: Block; type: BlockType | undefined }) {
  const { selectBlock } = usePanels();
  const isText = !type || type.isText;
  return (
    <div className="blk-collapsed" onClick={() => selectBlock(block.id)}>
      <BlockIcon
        iconKey={isText ? "type" : type?.iconKey}
        color={isText ? null : type?.iconColor}
        size={16}
      />
      <span className="blk-collapsed-title">
        {oneLineText(block.properties, block.content) || "Untitled"}
      </span>
    </div>
  );
}
