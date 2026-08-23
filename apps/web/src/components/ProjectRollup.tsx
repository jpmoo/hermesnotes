import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { api, type Block, type BlockType } from "../api.ts";
import { BlockIcon, CollectionIcon } from "../lib/icons.tsx";
import { usePreferences } from "../lib/preferences.tsx";
import { useBlockView, type BlockViewState } from "../lib/useBlockView.tsx";
import { CollapseAllButton, CollapsibleCard, useCollapse } from "./CollapsibleCard.tsx";

/**
 * A project is whatever the account calls a project.
 *
 * The built-in type is seeded as "project", but an account that had one of its
 * own before the built-in existed has a type with the same name and no builtin
 * flag — the same thing to the person using it, so it gets the same page.
 */
export const isProjectType = (type: BlockType | undefined): boolean =>
  (type?.name ?? "").trim().toLowerCase() === "project";

/** Where a connected block is filed: its type, or the fact that it's a collection. */
function sectionOf(b: Block): string {
  if (b.collectionKind) return "collection";
  return b.blockTypeId || "text";
}

/**
 * Sort and view selections per section, kept in the user's preferences bag.
 *
 * Not on the project block itself. Writing them there would bump its version
 * and its edited time every time someone changed a sort, and the page's own
 * editor is holding that same version — so arranging the tasks underneath a
 * project would collide with editing it. This is a reader's arrangement of
 * someone else's blocks, which is what the preferences bag is for; it syncs
 * across devices like the rest of it.
 */
function useSectionViews(blockId: string) {
  const { prefs, setPref } = usePreferences();
  const all = (prefs.block_views as Record<string, Record<string, BlockViewState>>) ?? {};
  // A ref, not the prop: two sections saving in the same moment would each
  // compute their next bag from the same stale snapshot, and the second would
  // drop the first's change.
  const map = useRef<Record<string, BlockViewState>>({});
  const seeded = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const [, bump] = useReducer((n: number) => n + 1, 0);

  // The bag arrives after the first render, so seed once it does — and only
  // once, or a save would be overwritten by the copy it was made from.
  if (!seeded.current && Object.keys(all).length > 0) {
    map.current = { ...(all[blockId] ?? {}) };
    seeded.current = true;
  }

  const save = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const bag = (prefs.block_views as Record<string, unknown>) ?? {};
      setPref("block_views", { ...bag, [blockId]: map.current });
    }, 600);
  };

  const viewFor = (key: string) => ({
    initial: map.current[key],
    onChange: (vs: BlockViewState) => {
      map.current = { ...map.current, [key]: vs };
      save();
    },
  });
  viewFor.patch = (key: string, part: BlockViewState) => {
    map.current = { ...map.current, [key]: { ...map.current[key], ...part } };
    save();
    bump();
  };
  return viewFor;
}

/** Which sections are shut, remembered per project so a reload keeps its shape. */
function useShut(blockId: string) {
  const key = `hn.projrollup.shut.${blockId}`;
  const [state, setState] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem(key);
      const v = raw ? JSON.parse(raw) : null;
      return v && typeof v === "object" ? (v as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  });
  return {
    isOpen: (k: string) => !state[k],
    toggle: (k: string) =>
      setState((p) => {
        const next = { ...p, [k]: !p[k] };
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* no storage: nothing remembered, nothing to keep */
        }
        return next;
      }),
  };
}

/** One type's worth of connected blocks, with its own arrangement. */
function Section({
  sectionKey,
  label,
  icon,
  blocks,
  types,
  projectId,
  viewFor,
  shut,
  onChanged,
}: {
  sectionKey: string;
  label: string;
  icon: ReactNode;
  blocks: Block[];
  types: BlockType[];
  projectId: string;
  viewFor: ReturnType<typeof useSectionViews>;
  shut: ReturnType<typeof useShut>;
  onChanged: () => void;
}) {
  const typeById = new Map(types.map((t) => [t.id, t]));
  const open = shut.isOpen(sectionKey);
  const scope = `project.${projectId}.${sectionKey}`;
  // Each section sorts itself. A due date orders tasks and means nothing to a
  // person or a note, so one sort across all of them would be the wrong sort
  // for every section but one.
  const { renderToolbar, renderList, viewMode, sortFields } = useBlockView(blocks, types, {
    scope,
    enableManual: false,
    viewState: viewFor(sectionKey),
  });
  const cards = useCollapse(blocks.map((b) => b.id), scope, {
    defaultCollapsed: viewFor(sectionKey).initial?.cardsCollapsed ?? true,
  });

  return (
    <section className="ru-branch ru-d0">
      <header className="ru-head">
        <button
          className="icon-btn ru-twist"
          title={open ? "Collapse" : "Expand"}
          onClick={() => shut.toggle(sectionKey)}
        >
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
        {icon}
        <span className="ru-title" title={label}>
          {label}
        </span>
        <span className="ru-count">{blocks.length}</span>
      </header>
      {open && (
        <div className="ru-body">
          {renderToolbar(
            viewMode !== "chips" && (
              <CollapseAllButton
                allCollapsed={cards.allCollapsed}
                onToggle={() => {
                  cards.toggleAll();
                  viewFor.patch(sectionKey, { cardsCollapsed: !cards.allCollapsed });
                }}
              />
            ),
          )}
          {renderList((b, compact) => (
            <CollapsibleCard
              block={b}
              type={b.blockTypeId ? typeById.get(b.blockTypeId) : undefined}
              compact={compact}
              collapsed={cards.isCollapsed(b.id)}
              onToggle={() => cards.toggle(b.id)}
              onConflict={onChanged}
              onDeleted={onChanged}
              fields={sortFields}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * What hangs off a project, on the project's own page: one section per type,
 * each arranged however that section is worth reading.
 *
 * A project is the one block people reach for expecting to see everything
 * around it, and the info pane's flat list of connections doesn't answer "what
 * is left to do here" — so this is the rollup a project would be if someone
 * built one for it, without their having to build it.
 *
 * Connected means connected, not "names this project in a reference field":
 * the notes that mention it, the canvases it was drawn on and the collections
 * it belongs to are all things around a project, and a section that quietly
 * showed only its tasks would be read as the whole answer.
 */
export function ProjectRollup({
  block,
  types,
  onChanged,
}: {
  block: Block;
  types: BlockType[];
  onChanged: () => void;
}) {
  const [kids, setKids] = useState<Block[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const { loaded } = usePreferences();
  const viewFor = useSectionViews(block.id);
  const shut = useShut(block.id);

  useEffect(() => {
    let alive = true;
    void api
      .get<{ blocks: Block[]; truncated: boolean }>(`/blocks/${block.id}/connected`)
      .then((r) => {
        if (!alive) return;
        setKids(r.blocks);
        setTruncated(r.truncated);
      })
      .catch(() => {
        if (alive) setKids([]);
      });
    return () => {
      alive = false;
    };
  }, [block.id]);

  // Nothing renders until the preferences bag has arrived. A section reads its
  // saved arrangement once, when it mounts, so mounting before the bag lands
  // would show every section with default sorting and never correct itself.
  if (!loaded || !kids || kids.length === 0) return null;

  const typeById = new Map(types.map((t) => [t.id, t]));
  const groups = new Map<string, Block[]>();
  for (const b of kids) {
    const k = sectionOf(b);
    groups.set(k, [...(groups.get(k) ?? []), b]);
  }
  const labelFor = (k: string) =>
    k === "collection" ? "Collections" : k === "text" ? "Text" : typeById.get(k)?.name ?? "Other";
  const iconFor = (k: string, sample: Block) => {
    if (k === "collection")
      return (
        <CollectionIcon
          document={sample.collectionKind === "document"}
          matrix={sample.collectionKind === "matrix"}
          table={sample.collectionKind === "table"}
          canvas={sample.collectionKind === "canvas"}
          calendar={sample.collectionKind === "calendar"}
          rollup={sample.collectionKind === "rollup"}
          size={16}
        />
      );
    const t = typeById.get(k);
    return (
      <BlockIcon
        iconKey={!t || t.isText ? "type" : t.iconKey}
        color={t && !t.isText ? t.iconColor : null}
        size={16}
      />
    );
  };
  const keys = [...groups.keys()].sort((a, b) => labelFor(a).localeCompare(labelFor(b)));

  return (
    <div className="proj-rollup">
      <div className="proj-rollup-head">
        {/* The style sheet does the shouting; the markup says it once, plainly. */}
        Project blocks <span className="ru-count">{kids.length}</span>
        {/* A cap that doesn't say so reads as "this is all of it". */}
        {truncated && <span className="hint">densely connected — showing the first {kids.length}</span>}
      </div>
      {keys.map((k) => (
        <Section
          key={k}
          sectionKey={k}
          label={labelFor(k)}
          icon={iconFor(k, groups.get(k)![0]!)}
          blocks={groups.get(k)!}
          types={types}
          projectId={block.id}
          viewFor={viewFor}
          shut={shut}
          onChanged={onChanged}
        />
      ))}
    </div>
  );
}
