import type { Block, BlockType } from "../api.ts";
import { oneLineText } from "../lib/display.ts";
import { BlockIcon } from "../lib/icons.tsx";
import { usePanels } from "../lib/right-panel.tsx";
import { Banner, type BannerValue } from "./Banner.tsx";

/** A collapsed block in list (block) view: icon + title on one line. Clicking
 * selects it into the info panel (where it can still be edited). */
export function CollapsedRow({
  block,
  type,
  masonry = false,
}: {
  block: Block;
  type: BlockType | undefined;
  masonry?: boolean;
}) {
  const { selectBlock } = usePanels();
  const isText = !type || type.isText;
  const banner = ((block.properties as Record<string, unknown>).banner as BannerValue | null) ?? null;
  const row = (
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
  // Masonry collapsed cards are all the same height: a fixed slice area
  // (the banner, or a blank placeholder) above the title row.
  if (masonry) {
    return (
      <div className="blk-collapsed-card" onClick={() => selectBlock(block.id)}>
        {banner ? (
          <Banner value={banner} height={56} className="banner-slice collapsed" />
        ) : (
          <div className="blk-collapsed-slice" />
        )}
        {row}
      </div>
    );
  }
  return row;
}
