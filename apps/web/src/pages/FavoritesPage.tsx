import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, ChevronUp, Star } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type Block, type BlockType } from "../api.ts";
import { BlockCard } from "../components/BlockCard.tsx";
import { Banner, BannerAddButton, type BannerValue } from "../components/Banner.tsx";
import { CollapsedRow } from "../components/CollapsedRow.tsx";
import { ColorPickerModal } from "../components/ColorPickerModal.tsx";
import { darkTextOn, oneLineText } from "../lib/display.ts";
import { CollectionIcon } from "../lib/icons.tsx";
import { usePanels } from "../lib/right-panel.tsx";
import { useBlockDeleted } from "../lib/block-events.ts";
import { usePreferences } from "../lib/preferences.tsx";
import { useBlockView } from "../lib/useBlockView.tsx";

/**
 * Starred blocks and collections. Same sort/view controls as All blocks
 * (block list / masonry, per-card collapse); collections are listed on top
 * as open-able rows.
 */
type StripSort = "manual" | "alpha" | "created" | "edited";
const STRIP_SORT_KEY = "hn.fav.collections.sort";
const STRIP_COLS_KEY = "hn.fav.collections.cols";
const clampStripCols = (n: number) => Math.min(10, Math.max(1, n || 4));

/** A starred-collection chip; draggable in manual order. */
function FavChip({ id, draggable, children }: { id: string; draggable: boolean; children: ReactNode }) {
  const s = useSortable({ id, disabled: !draggable });
  const style = {
    transform: CSS.Translate.toString(s.transform),
    transition: s.transition,
    display: "flex",
    minWidth: 0,
  };
  return (
    <div ref={s.setNodeRef} style={style} {...s.attributes} {...s.listeners}>
      {children}
    </div>
  );
}

export function FavoritesPage() {
  const { favorites, setPref, banner, setBanner } = usePreferences();
  const { openBlock, selectPage } = usePanels();
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [types, setTypes] = useState<BlockType[]>([]);
  const [loading, setLoading] = useState(true);
  const typeById = new Map(types.map((t) => [t.id, t]));
  useBlockDeleted((bid) => setBlocks((prev) => prev.filter((b) => b.id !== bid)));

  useEffect(() => {
    void api.get<BlockType[]>("/block-types").then(setTypes).catch(() => {});
    selectPage("favorites");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const favKey = favorites.join(",");
  useEffect(() => {
    let alive = true;
    setLoading(true);
    void Promise.all(
      favorites.map((id) => api.get<Block>(`/blocks/${id}`).catch(() => null)),
    )
      .then((rs) => {
        if (alive) setBlocks(rs.filter((b): b is Block => b !== null));
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [favKey]);

  const collections = blocks.filter((b) => b.collectionKind);
  const plain = blocks.filter((b) => !b.collectionKind);

  // Strip sort: same options as everywhere (manual = the favorites order,
  // synced via preferences; drag chips to arrange).
  const [stripSort, setStripSort] = useState<StripSort>(() => {
    try {
      const v = localStorage.getItem(STRIP_SORT_KEY);
      return v === "alpha" || v === "created" || v === "edited" ? v : "manual";
    } catch {
      return "manual";
    }
  });
  const [stripDir, setStripDir] = useState<"asc" | "desc">("asc");
  const [stripCols, setStripColsState] = useState<number>(() => {
    try {
      return clampStripCols(Number(localStorage.getItem(STRIP_COLS_KEY)));
    } catch {
      return 4;
    }
  });
  const setStripCols = (n: number) => {
    const c = clampStripCols(n);
    setStripColsState(c);
    try {
      localStorage.setItem(STRIP_COLS_KEY, String(c));
    } catch {
      /* ignore */
    }
  };
  const pickStripSort = (v: StripSort) => {
    setStripSort(v);
    try {
      localStorage.setItem(STRIP_SORT_KEY, v);
    } catch {
      /* ignore */
    }
  };
  const sortedCollections = useMemo(() => {
    if (stripSort === "manual") {
      const order = new Map(favorites.map((id, i) => [id, i]));
      return [...collections].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    }
    const val = (b: Block) =>
      stripSort === "alpha"
        ? (oneLineText(b.properties) || "").toLowerCase()
        : stripSort === "created"
          ? b.createdAt
          : b.updatedAt;
    const r = [...collections].sort((a, b) => val(a).localeCompare(val(b)));
    return stripDir === "desc" ? r.reverse() : r;
  }, [collections, stripSort, stripDir, favorites]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // Per-chip background: right-click → set/clear, stored on the collection
  // (bg_color), so the Collections page rows share it.
  const [chipMenu, setChipMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [coloring, setColoring] = useState<Block | null>(null);
  useEffect(() => {
    if (!chipMenu) return;
    const close = () => setChipMenu(null);
    document.addEventListener("mousedown", close);
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [chipMenu]);
  const setChipColor = (id: string, color: string | null) => {
    void api.patch(`/collections/${id}`, { bg_color: color }).then(reload);
  };
  const onChipDrag = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = sortedCollections.map((c) => c.id);
    const next = arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
    // Rewrite the collection ids within the favorites array, blocks untouched.
    const isCol = new Set(ids);
    let i = 0;
    setPref(
      "favorites",
      favorites.map((id) => (isCol.has(id) ? next[i++]! : id)),
    );
  };

  const reload = () => {
    void Promise.all(favorites.map((id) => api.get<Block>(`/blocks/${id}`).catch(() => null))).then(
      (rs) => setBlocks(rs.filter((b): b is Block => b !== null)),
    );
  };

  const { toolbar, renderList, viewMode } = useBlockView(plain, types, { scope: "favorites" });

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const allCollapsed = plain.length > 0 && plain.every((b) => collapsed.has(b.id));
  const toggleCard = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      {(banner("favorites") as BannerValue | null) && (
        <Banner
          value={banner("favorites") as BannerValue}
          editable
          onChange={(v) => setBanner("favorites", v)}
        />
      )}
      <div className="page-head">
        <h1 className="page-title title-with-icon">
        <Star size={22} color="#26282b" />
        Favorites
      </h1>
        {!(banner("favorites")) && (
          <BannerAddButton className="page-head-add" onAdded={(v) => setBanner("favorites", v)} />
        )}
      </div>
      <p className="page-sub">Starred blocks and collections (star them in the info panel).</p>

      {collections.length > 0 && (
        <div className="row" style={{ marginBottom: 10, gap: 12 }}>
          <span className="sort-label">Collections</span>
          {collections.length > 1 && (
            <div className="sort-bar" style={{ marginBottom: 0 }}>
              <div className="segmented">
                {(
                  [
                    ["manual", "Manual"],
                    ["alpha", "Alphabetical"],
                    ["created", "Created"],
                    ["edited", "Edited"],
                  ] as [StripSort, string][]
                ).map(([k, label]) => (
                  <button key={k} className={`seg${stripSort === k ? " active" : ""}`} onClick={() => pickStripSort(k)}>
                    {label}
                  </button>
                ))}
              </div>
              {stripSort !== "manual" && (
                <button
                  className="icon-btn sort-dir"
                  title={stripDir === "asc" ? "Ascending" : "Descending"}
                  onClick={() => setStripDir(stripDir === "asc" ? "desc" : "asc")}
                >
                  {stripDir === "asc" ? "↑" : "↓"}
                </button>
              )}
              {stripSort === "manual" && <span className="hint">Drag chips to arrange</span>}
              <span className="cols-ctl">
                <span className="hint">Cols</span>
                <button className="icon-btn" onClick={() => setStripCols(stripCols - 1)} title="Fewer columns">
                  −
                </button>
                <span className="cols-n">{stripCols}</span>
                <button className="icon-btn" onClick={() => setStripCols(stripCols + 1)} title="More columns">
                  +
                </button>
              </span>
            </div>
          )}
        </div>
      )}
      {collections.length > 0 && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onChipDrag}>
          <SortableContext items={sortedCollections.map((c) => c.id)} strategy={rectSortingStrategy}>
            <div
              className="fav-collections"
              style={{ gridTemplateColumns: `repeat(${stripCols}, minmax(0, 1fr))` }}
            >
              {sortedCollections.map((c) => (
                <FavChip key={c.id} id={c.id} draggable={stripSort === "manual"}>
                  <button
                    className="sec-sublink fav-collection"
                    style={
                      typeof c.properties.bg_color === "string" && c.properties.bg_color
                        ? {
                            background: c.properties.bg_color,
                            color: darkTextOn(c.properties.bg_color) ? "#26282b" : "#ffffff",
                          }
                        : undefined
                    }
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setChipMenu({ id: c.id, x: e.clientX, y: e.clientY });
                    }}
                    onClick={() => openBlock(c.id, { collection: true })}
                  >
                    <CollectionIcon
                      document={c.collectionKind === "document"}
                      matrix={c.collectionKind === "matrix"}
                      table={c.collectionKind === "table"}
                canvas={c.collectionKind === "canvas"}
                      smart={(c.properties as Record<string, unknown>)?.membership_mode === "smart"}
                      size={15}
                    />
                    <span className="fav-collection-label">
                      {oneLineText(c.properties) || "Untitled collection"}
                    </span>
                  </button>
                </FavChip>
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {plain.length > 0 && (
        <div className="row" style={{ marginBottom: 10, gap: 12 }}>
          <span className="sort-label">Blocks</span>
          {toolbar}
          {viewMode !== "chips" && (
            <button
              className="ghost"
              onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(plain.map((b) => b.id)))}
            >
              {allCollapsed ? "Expand all" : "Collapse all"}
            </button>
          )}
        </div>
      )}

      {chipMenu && (
        <div
          className="menu"
          style={{ position: "fixed", left: chipMenu.x, top: chipMenu.y, right: "auto" }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="menu-item"
            onClick={() => {
              setColoring(collections.find((c) => c.id === chipMenu.id) ?? null);
              setChipMenu(null);
            }}
          >
            Set background…
          </button>
          {typeof collections.find((c) => c.id === chipMenu.id)?.properties.bg_color === "string" && (
            <button
              className="menu-item"
              onClick={() => {
                setChipColor(chipMenu.id, null);
                setChipMenu(null);
              }}
            >
              Clear background
            </button>
          )}
        </div>
      )}
      {coloring && (
        <ColorPickerModal
          open
          title="Chip background"
          value={
            typeof coloring.properties.bg_color === "string" && coloring.properties.bg_color
              ? coloring.properties.bg_color
              : "#eef4f6"
          }
          onCancel={() => setColoring(null)}
          onSave={(c) => {
            setChipColor(coloring.id, c);
            setColoring(null);
          }}
        />
      )}
      {loading ? (
        <div className="hint">Loading…</div>
      ) : blocks.length === 0 ? (
        <div className="hint">Nothing starred yet — use the ★ in the info panel.</div>
      ) : (
        renderList((b, compact) => {
          const col = collapsed.has(b.id);
          return (
            <div className="bv-card-wrap">
              <button
                className="icon-btn card-collapse"
                title={col ? "Expand" : "Collapse"}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleCard(b.id);
                }}
              >
                {col ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
              </button>
              {col ? (
                // Masonry keeps a small banner slice; block view is one line.
                <CollapsedRow block={b} type={typeById.get(b.blockTypeId)} masonry={compact} />
              ) : (
                <BlockCard
                  block={b}
                  type={typeById.get(b.blockTypeId)}
                  onConflict={reload}
                  onDeleted={reload}
                  compact={compact}
                />
              )}
            </div>
          );
        })
      )}
    </>
  );
}
