import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import type { Block, BlockType } from "../api.ts";
import { BlockCard } from "./BlockCard.tsx";
import { CollapsedRow } from "./CollapsedRow.tsx";

/** Per-list collapse state: which card ids are collapsed, with all-toggle. */
export function useCollapse(ids: string[]) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allCollapsed = ids.length > 0 && ids.every((id) => collapsed.has(id));
  const toggleAll = () => setCollapsed(allCollapsed ? new Set() : new Set(ids));
  return { collapsed, toggle, allCollapsed, toggleAll };
}

/**
 * A block card with a collapse handle (top-right). Collapsed → a one-line
 * title in block view, or a banner-slice/preview card in masonry (compact).
 */
export function CollapsibleCard({
  block,
  type,
  compact,
  collapsed,
  onToggle,
  onConflict,
  onDeleted,
}: {
  block: Block;
  type: BlockType | undefined;
  compact: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onConflict: () => void;
  onDeleted: (id: string) => void;
}) {
  return (
    <div className="bv-card-wrap">
      <button
        className="icon-btn card-collapse"
        title={collapsed ? "Expand" : "Collapse"}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
      >
        {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
      </button>
      {collapsed ? (
        <CollapsedRow block={block} type={type} />
      ) : (
        <BlockCard
          block={block}
          type={type}
          onConflict={onConflict}
          onDeleted={onDeleted}
          compact={compact}
        />
      )}
    </div>
  );
}
