import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import type { Block, BlockType } from "../api.ts";
import { BlockCard } from "./BlockCard.tsx";
import { CollapsedRow } from "./CollapsedRow.tsx";

/**
 * Per-list collapse state: which card ids are collapsed, with all-toggle. When a
 * `scope` is given, the collapsed set persists in localStorage under that key, so
 * a page keeps its expand/collapse state across navigation and reloads.
 */
export function useCollapse(ids: string[], scope?: string) {
  const key = scope ? `hn.collapse.${scope}` : null;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    if (!key) return new Set();
    try {
      const raw = localStorage.getItem(key);
      return raw ? new Set<string>(JSON.parse(raw) as string[]) : new Set();
    } catch {
      return new Set();
    }
  });
  const write = (next: Set<string>) => {
    if (key) {
      try {
        localStorage.setItem(key, JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
    }
    return next;
  };
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return write(next);
    });
  const allCollapsed = ids.length > 0 && ids.every((id) => collapsed.has(id));
  const toggleAll = () => setCollapsed(() => write(allCollapsed ? new Set() : new Set(ids)));
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
