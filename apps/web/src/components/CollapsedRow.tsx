import type { Block, BlockType } from "../api.ts";
import { flattenMentions, oneLineText } from "../lib/display.ts";
import { BlockIcon } from "../lib/icons.tsx";
import { usePanels } from "../lib/right-panel.tsx";
import { Banner, type BannerValue } from "./Banner.tsx";

/** A collapsed block in list (block) view: icon + title on one line. Clicking
 * selects it into the info panel (where it can still be edited). */
export function CollapsedRow({
  block,
  type,
}: {
  block: Block;
  type: BlockType | undefined;
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
  // Uniform collapsed card in every view: with a banner → slice on top, title
  // below; without → title on top, a preview of the note below. Same height
  // either way.
  if (banner) {
    return (
      <div className="blk-collapsed-card" onClick={() => selectBlock(block.id)}>
        <Banner value={banner} height={56} className="banner-slice collapsed" />
        {row}
      </div>
    );
  }
  return (
    <div className="blk-collapsed-card" onClick={() => selectBlock(block.id)}>
      {row}
      <div className="blk-collapsed-preview">{previewOf(block, isText)}</div>
    </div>
  );
}

/** Plain-text preview of a block's body (everything after the title line for a
 * text note; the description field for a typed block). */
function previewOf(block: Block, isText: boolean): string {
  if (isText) {
    const content = block.content ?? "";
    const start = content.search(/\S/);
    if (start < 0) return "";
    const nl = content.indexOf("\n", start);
    return flattenMentions(nl >= 0 ? content.slice(nl + 1).trim() : "");
  }
  const desc = (block.properties as Record<string, unknown>).description;
  return typeof desc === "string" ? flattenMentions(desc.trim()) : "";
}
