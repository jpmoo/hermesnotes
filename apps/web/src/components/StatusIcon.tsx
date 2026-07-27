import { useState } from "react";
import { api, type Block, type BlockType } from "../api.ts";
import { emitBlockChange, useBlockOrigin, useBlockSync } from "../lib/block-events.ts";
import { BlockIcon } from "../lib/icons.tsx";

/**
 * A block's leading glyph. For a typed block with a status field it renders the
 * current status's icon/color as a button that cycles status in place (persisted
 * with optimistic version handling, broadcast on the block bus so every surface
 * stays in sync). Text and status-less blocks get the plain, non-interactive
 * type icon. Reused across chips, collapsed rows, lists, etc.
 */
export function StatusIcon({
  block,
  type,
  size = 16,
  className,
}: {
  block: { id: string; properties: Record<string, unknown>; version?: number };
  type: BlockType | undefined;
  size?: number;
  className?: string;
}) {
  const isText = !type || type.isText;
  const origin = useBlockOrigin();
  const [props, setProps] = useState<Record<string, unknown>>(block.properties);
  const [version, setVersion] = useState<number | undefined>(block.version);
  useBlockSync(block.id, origin, (b) => {
    setProps(b.properties);
    setVersion(b.version);
  });

  const schema = type?.propertySchema;
  const statusKey = schema?.status_field ?? null;
  const statusField = schema?.fields.find((f) => f.type === "status" && f.key === statusKey) ?? null;

  if (!statusField || !statusKey) {
    return <BlockIcon iconKey={isText ? "type" : type?.iconKey} color={isText ? null : type?.iconColor} size={size} />;
  }

  const status = String(props[statusKey] ?? "");
  const cycle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const opts = statusField.options ?? [];
    const next = opts[(opts.indexOf(status) + 1) % opts.length];
    if (!next) return;
    const nextProps = { ...props, [statusKey]: next };
    setProps(nextProps);
    try {
      const v = version ?? (await api.get<Block>(`/blocks/${block.id}`)).version;
      const updated = await api.patch<Block>(`/blocks/${block.id}`, { properties: nextProps, version: v });
      setVersion(updated.version);
      emitBlockChange(block.id, origin);
    } catch {
      /* keep local; a refresh will reconcile */
    }
  };

  return (
    <button
      className={`li-status${className ? ` ${className}` : ""}`}
      title={`Status: ${status.replace(/_/g, " ")}`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => void cycle(e)}
    >
      <BlockIcon
        iconKey={statusField.optionIcons?.[status] ?? type?.iconKey}
        color={statusField.optionColors?.[status] ?? type?.iconColor}
        size={size}
      />
    </button>
  );
}
