import { optionLabel } from "@hermes/shared";
import { useState } from "react";
import { api, type Block, type BlockType } from "../api.ts";
import { emitBlockChange, useBlockOrigin, useBlockSync } from "../lib/block-events.ts";
import { flattenMentions, oneLineText, rawOneLine } from "../lib/display.ts";
import { MentionText } from "./MentionText.tsx";
import { BlockIcon } from "../lib/icons.tsx";
import { usePanels } from "../lib/right-panel.tsx";
import { Banner, type BannerValue } from "./Banner.tsx";
import { FieldChips } from "./FieldChips.tsx";
import type { ShownField } from "../lib/field-text.ts";

/** A collapsed block in list (block) view: icon + title on one line. Clicking
 * the row selects it into the info panel; a typed block's status icon stays
 * live — click it to cycle status without expanding. */
export function CollapsedRow({
  block,
  type,
  fields = [],
}: {
  block: Block;
  type: BlockType | undefined;
  /** Properties the list is sorted by — shown so the order can be read. */
  fields?: ShownField[];
}) {
  const { selectOrOpen } = usePanels();
  const isText = !type || type.isText;
  const origin = useBlockOrigin();
  const [props, setProps] = useState<Record<string, unknown>>(block.properties);
  const [version, setVersion] = useState(block.version);
  useBlockSync(block.id, origin, (b) => {
    setProps(b.properties);
    setVersion(b.version);
  });

  const schema = type?.propertySchema;
  const statusKey = schema?.status_field ?? null;
  const statusField = schema?.fields.find((f) => f.type === "status" && f.key === statusKey) ?? null;
  const status = statusKey ? String(props[statusKey] ?? "") : "";

  const cycleStatus = async () => {
    if (!statusField || !statusKey) return;
    const opts = statusField.options ?? [];
    const next = opts[(opts.indexOf(status) + 1) % opts.length];
    if (!next) return;
    const nextProps = { ...props, [statusKey]: next };
    setProps(nextProps);
    try {
      const updated = await api.patch<Block>(`/blocks/${block.id}`, { properties: nextProps, version });
      setVersion(updated.version);
      emitBlockChange(block.id, origin);
    } catch {
      /* keep local; a refresh will reconcile */
    }
  };

  const banner = (props.banner as BannerValue | null) ?? null;
  const icon = statusField ? (
    <button
      className="li-status blk-collapsed-status"
      title={`Status: ${statusField ? optionLabel(statusField, status) : status.replace(/_/g, " ")}`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        void cycleStatus();
      }}
    >
      <BlockIcon
        iconKey={statusField.optionIcons?.[status] ?? type?.iconKey}
        color={statusField.optionColors?.[status] ?? type?.iconColor}
        size={16}
      />
    </button>
  ) : (
    <BlockIcon iconKey={isText ? "type" : type?.iconKey} color={isText ? null : type?.iconColor} size={16} />
  );

  const row = (
    <div className="blk-collapsed" onClick={() => selectOrOpen(block.id)}>
      {icon}
      <span className="blk-collapsed-title">
        {rawOneLine(props, block.content) ? (
          <MentionText text={rawOneLine(props, block.content)} />
        ) : (
          "Untitled"
        )}
      </span>
      <FieldChips fields={fields} properties={props} />
    </div>
  );
  // Uniform collapsed card in every view: with a banner → slice on top, title
  // below; without → title on top, a preview of the note below. Same height
  // either way.
  if (banner) {
    return (
      <div className="blk-collapsed-card" onClick={() => selectOrOpen(block.id)}>
        <Banner value={banner} height={56} className="banner-slice collapsed" />
        {row}
      </div>
    );
  }
  return (
    <div className="blk-collapsed-card" onClick={() => selectOrOpen(block.id)}>
      {row}
      <div className="blk-collapsed-preview">{previewOf(block, props, isText)}</div>
    </div>
  );
}

/** Plain-text preview of a block's body (everything after the title line for a
 * text note; the description field for a typed block). */
function previewOf(block: Block, props: Record<string, unknown>, isText: boolean): string {
  if (isText) {
    const content = block.content ?? "";
    const start = content.search(/\S/);
    if (start < 0) return "";
    const nl = content.indexOf("\n", start);
    return flattenMentions(nl >= 0 ? content.slice(nl + 1).trim() : "");
  }
  const desc = props.description;
  return typeof desc === "string" ? flattenMentions(desc.trim()) : "";
}
