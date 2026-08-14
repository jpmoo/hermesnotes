import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { useState } from "react";
import type { Block, BlockType } from "../api.ts";
import { BlockCard } from "./BlockCard.tsx";
import { CollapsedRow } from "./CollapsedRow.tsx";
import type { ShownField } from "../lib/field-text.ts";

/**
 * Per-list collapse state: each card's collapsed flag, with an all-toggle. When
 * a `scope` is given, the state persists in localStorage under that key — an
 * id→collapsed map, so a card's setting is remembered per block and survives
 * navigation/reloads (and, for a stable scope like the Today sections, across
 * days). Ids never seen before fall back to `opts.defaultCollapsed` (default
 * expanded). Consumers can read `collapsed.has(id)` or `isCollapsed(id)`.
 */
export function useCollapse(ids: string[], scope?: string, opts?: { defaultCollapsed?: boolean }) {
  const def = opts?.defaultCollapsed ?? false;
  const key = scope ? `hn.collapse.${scope}` : null;
  const [state, setState] = useState<Record<string, boolean>>(() => {
    if (!key) return {};
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      // Migrate the legacy format (a plain array of collapsed ids).
      if (Array.isArray(parsed)) return Object.fromEntries((parsed as string[]).map((id) => [id, true]));
      return parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  });
  const write = (next: Record<string, boolean>) => {
    if (key) {
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* ignore */
      }
    }
    return next;
  };
  const isCollapsed = (id: string) => state[id] ?? def;
  const collapsed = new Set(ids.filter(isCollapsed));
  const toggle = (id: string) => setState((prev) => write({ ...prev, [id]: !(prev[id] ?? def) }));
  const allCollapsed = ids.length > 0 && ids.every(isCollapsed);
  const toggleAll = () =>
    setState((prev) => {
      const target = !allCollapsed;
      const next = { ...prev };
      for (const id of ids) next[id] = target;
      return write(next);
    });
  return { collapsed, isCollapsed, toggle, allCollapsed, toggleAll };
}

/**
 * The all-at-once collapse toggle, as a button in the view's own toolbar rather
 * than a line of link text trailing off the end of it. It acts on what the
 * toolbar is showing, so that's where it belongs — pass it to `renderToolbar`.
 *
 * Takes the pieces rather than the whole `useCollapse` result, because not every
 * list keeps its collapse state that way (Favorites holds it in local state).
 */
export function CollapseAllButton({
  allCollapsed,
  onToggle,
}: {
  allCollapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button className="bar-btn" onClick={onToggle}>
      {allCollapsed ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />}
      {allCollapsed ? "Expand blocks" : "Collapse blocks"}
    </button>
  );
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
  fields = [],
}: {
  block: Block;
  type: BlockType | undefined;
  compact: boolean;
  collapsed: boolean;
  /** Properties the list is sorted by, for the collapsed form to show. */
  fields?: ShownField[];
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
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
      </button>
      {collapsed ? (
        <CollapsedRow block={block} type={type} fields={fields} />
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
