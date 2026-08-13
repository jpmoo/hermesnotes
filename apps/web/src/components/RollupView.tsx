import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { Collection, BlockType } from "../api.ts";
import { oneLineText } from "../lib/display.ts";
import { BlockIcon, CollectionIcon } from "../lib/icons.tsx";
import { usePanels } from "../lib/right-panel.tsx";
import { useRollup, walk, type RollupNode } from "../lib/rollup.ts";
import { useBlockView } from "../lib/useBlockView.tsx";
import { BlockCard } from "./BlockCard.tsx";

/** Open/closed per branch, remembered per rollup so a page reload keeps its shape. */
function useBranches(collectionId: string) {
  const key = `hn.rollup.open.${collectionId}`;
  const [state, setState] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem(key);
      const v = raw ? JSON.parse(raw) : null;
      return v && typeof v === "object" ? (v as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  });
  const write = (next: Record<string, boolean>) => {
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* ignore */
    }
    return next;
  };
  return {
    // A branch nobody has touched starts open: a rollup you've just built
    // should show what it found, not a row of closed shutters.
    isOpen: (path: string) => state[path] ?? true,
    toggle: (path: string) => setState((p) => write({ ...p, [path]: !(p[path] ?? true) })),
    setAll: (paths: string[], open: boolean) =>
      setState((p) => write({ ...p, ...Object.fromEntries(paths.map((x) => [x, open])) })),
  };
}

/**
 * One branch of the rollup: a heading for the block it stands for, and beneath
 * it either the next level's branches or — at the last level — that level's
 * blocks, laid out by that branch's own sort and view controls.
 *
 * Each branch keeps its own controls, scoped to its block, which is what makes
 * one project readable as masonry while the next is a row of chips.
 */
function Branch({
  node,
  types,
  collectionId,
  depth,
  levels,
  branches,
  onChanged,
}: {
  node: RollupNode;
  types: BlockType[];
  collectionId: string;
  depth: number;
  /** How many levels the rollup has, so the deepest one renders as cards. */
  levels: number;
  branches: ReturnType<typeof useBranches>;
  onChanged: () => void;
}) {
  const { selectOrOpen } = usePanels();
  const typeById = new Map(types.map((t) => [t.id, t]));
  const type = node.block.blockTypeId ? typeById.get(node.block.blockTypeId) : undefined;
  const open = branches.isOpen(node.path);
  const label = oneLineText(node.block.properties, node.block.content) || "Untitled";
  const kids = node.children;
  // The children of this branch are the last level when there's nothing
  // configured below them — that's where blocks stop being headings and
  // become cards.
  const lastLevel = depth + 1 >= levels;

  // Scoped to the block, not the branch: the same project reached from two
  // roots is the same project, and should look the same in both.
  const { toolbar, renderList } = useBlockView(
    kids.map((k) => k.block),
    types,
    { scope: `rollup.${collectionId}.${node.block.id}` },
  );

  return (
    <section className={`ru-branch ru-d${Math.min(depth, 3)}`}>
      <header className="ru-head">
        <button
          className="icon-btn ru-twist"
          title={open ? "Collapse" : "Expand"}
          onClick={() => branches.toggle(node.path)}
        >
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
        {node.block.collectionKind ? (
          <CollectionIcon
            document={node.block.collectionKind === "document"}
            matrix={node.block.collectionKind === "matrix"}
            table={node.block.collectionKind === "table"}
            canvas={node.block.collectionKind === "canvas"}
            calendar={node.block.collectionKind === "calendar"}
            rollup={node.block.collectionKind === "rollup"}
            size={16}
          />
        ) : (
          <BlockIcon
            iconKey={!type || type.isText ? "type" : type.iconKey}
            color={type && !type.isText ? type.iconColor : null}
            size={16}
          />
        )}
        <button className="ru-title" onClick={() => selectOrOpen(node.block.id)} title={label}>
          {label}
        </button>
        <span className="ru-count">{kids.length}</span>
      </header>

      {open && (
        <div className="ru-body">
          {kids.length === 0 ? (
            <div className="hint ru-empty">Nothing at this level.</div>
          ) : lastLevel ? (
            <>
              {toolbar}
              {renderList((b, compact) => (
                <BlockCard
                  block={b}
                  type={b.blockTypeId ? typeById.get(b.blockTypeId) : undefined}
                  onConflict={onChanged}
                  onDeleted={onChanged}
                  compact={compact}
                />
              ))}
            </>
          ) : (
            kids.map((k) => (
              <Branch
                key={k.path}
                node={k}
                types={types}
                collectionId={collectionId}
                depth={depth + 1}
                levels={levels}
                branches={branches}
                onChanged={onChanged}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}

/**
 * A rollup collection: what's nested under what. The roots supply the top row
 * of headings; each configured level says how to find what belongs beneath the
 * level above, so "Projects, then tasks" reads as a project per heading with
 * its own tasks under it.
 *
 * It holds no memberships — everything shown lives wherever it already lives,
 * and is only being looked at from here.
 */
export function RollupView({
  collection,
  types,
  refreshTick,
  onChanged,
}: {
  collection: Collection;
  types: BlockType[];
  /** Bumped by the page to rebuild after an edit elsewhere. */
  refreshTick: number;
  onChanged: () => void;
}) {
  const { config, tree, problems, error } = useRollup(
    collection.properties.rollup,
    collection.id,
    refreshTick,
  );
  const branches = useBranches(collection.id);
  const [allOpen, setAllOpen] = useState(true);
  // Deep levels can go quiet for a moment while each level is fetched; say so
  // rather than showing an empty rollup that looks configured wrong.
  const loading = tree === null;

  if (config.roots.length === 0) {
    return (
      <div className="hint">
        Nothing rolled up yet. Choose what sits at the top — a collection, whose members each become
        a heading, or a single note — in the Rollup panel on the right, then add a level for what
        belongs underneath.
      </div>
    );
  }
  if (error) return <div className="hint">{error}</div>;
  if (loading) return <div className="hint">Building…</div>;
  // Whatever the top level couldn't give us, said plainly — an empty list, a
  // deleted item, a request that failed — rather than one flat "nothing".
  const notes = problems.length > 0 && (
    <div className="ru-problems">
      {problems.map((p, i) => (
        <div className="hint" key={i}>
          {p}
        </div>
      ))}
    </div>
  );
  if (tree.length === 0) {
    return <div>{notes || <div className="hint">Nothing at the top level yet.</div>}</div>;
  }

  const paths = walk(tree).map((n) => n.path);
  return (
    <div className="ru-view">
      {notes}
      <div className="row ru-tools">
        <button
          className="ghost"
          onClick={() => {
            const open = !allOpen;
            setAllOpen(open);
            branches.setAll(paths, open);
          }}
        >
          {allOpen ? "Collapse all" : "Expand all"}
        </button>
        <span className="hint">
          {config.levels.length === 0
            ? "No levels yet — add one in the Rollup panel to say what belongs under these."
            : `${tree.length} at the top · ${walk(tree).length - tree.length} below`}
        </span>
      </div>
      {tree.map((n) => (
        <Branch
          key={n.path}
          node={n}
          types={types}
          collectionId={collection.id}
          depth={0}
          levels={config.levels.length}
          branches={branches}
          onChanged={onChanged}
        />
      ))}
    </div>
  );
}
