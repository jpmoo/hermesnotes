import { Archive, CalendarDays, ChevronLeft, ChevronRight, Clock, Layers, Library, ListChecks, Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Block, type BlockType } from "../api.ts";
import { oneLineText } from "../lib/display.ts";
import { BlockIcon, CollectionIcon } from "../lib/icons.tsx";
import { usePanels } from "../lib/right-panel.tsx";
import { usePreferences } from "../lib/preferences.tsx";

const fmtDay = (date: string) =>
  new Date(`${date}T00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

interface RecentInfo {
  label: string;
  blockTypeId: string | null;
  properties?: Record<string, unknown>;
  document?: boolean;
  matrix?: boolean;
  table?: boolean;
  canvas?: boolean;
  calendar?: boolean;
  smart?: boolean;
}

// Cache recent-entry labels so the dropdown doesn't refetch each open.
const infoCache = new Map<string, Promise<RecentInfo>>();
const getInfo = (id: string) =>
  infoCache.get(id) ??
  infoCache
    .set(
      id,
      api
        .get<Block>(`/blocks/${id}`)
        .then((b) => ({
          label: oneLineText(b.properties, b.content) || "Untitled",
          blockTypeId: b.blockTypeId,
          properties: b.properties,
          document: b.collectionKind === "document",
          matrix: b.collectionKind === "matrix",
          table: b.collectionKind === "table",
          canvas: b.collectionKind === "canvas",
          calendar: b.collectionKind === "calendar",
          smart: (b.properties as Record<string, unknown>)?.membership_mode === "smart",
        }))
        .catch(() => ({ label: "(unknown)", blockTypeId: null })),
    )
    .get(id)!;

function RecentsMenu() {
  const { recents, selectedBlockId, selectedToday, openBlock } = usePanels();
  const { colors } = usePreferences();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<Record<string, RecentInfo>>({});
  const [types, setTypes] = useState<BlockType[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    void api.get<BlockType[]>("/block-types").then(setTypes);
    recents.forEach((e) => {
      if (e.kind === "today" || e.kind === "page" || info[e.id]) return;
      void getInfo(e.id).then((v) => setInfo((m) => ({ ...m, [e.id]: v })));
    });
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, recents]);

  return (
    <div className="nav-kebab" ref={ref} style={{ position: "relative" }}>
      <button className="icon-btn" title="History" onClick={() => setOpen((o) => !o)}>
        <Clock size={15} />
      </button>
      {open && (
        <div className="menu recents-menu">
          {recents.length === 0 ? (
            <div className="hint" style={{ padding: "6px 10px" }}>
              Nothing recent
            </div>
          ) : (
            recents.map((e) => {
              if (e.kind === "page") {
                // Match the rail: each page's icon uses that nav row's icon color.
                const meta = {
                  blocks: { Icon: Layers, label: "All blocks", key: "allblocks_colors" },
                  collections: { Icon: Library, label: "Collections", key: "collections_colors" },
                  favorites: { Icon: Star, label: "Favorites", key: "favorites_colors" },
                  archive: { Icon: Archive, label: "Archive", key: "archive_colors" },
                  review: { Icon: ListChecks, label: "Weekly Review", key: "review_colors" },
                }[e.page];
                return (
                  <button
                    key={`p:${e.page}`}
                    className="menu-item recent-item"
                    onClick={() => {
                      nav(`/${e.page}`);
                      setOpen(false);
                    }}
                  >
                    <meta.Icon size={14} color={colors(meta.key).icon ?? undefined} />
                    <span className="recent-label">{meta.label}</span>
                  </button>
                );
              }
              if (e.kind === "today") {
                return (
                  <button
                    key={`t:${e.date}`}
                    className={`menu-item recent-item${e.date === selectedToday ? " active" : ""}`}
                    onClick={() => {
                      nav(`/today/${e.date}`);
                      setOpen(false);
                    }}
                  >
                    <CalendarDays size={14} color={colors("today_colors").icon ?? undefined} />
                    <span className="recent-label">Today · {fmtDay(e.date)}</span>
                  </button>
                );
              }
              const it = info[e.id];
              const active = e.id === selectedBlockId && !selectedToday;
              if (e.kind === "collection") {
                return (
                  <button
                    key={`c:${e.id}`}
                    className={`menu-item recent-item${active ? " active" : ""}`}
                    onClick={() => {
                      openBlock(e.id, { collection: true });
                      setOpen(false);
                    }}
                  >
                    <CollectionIcon document={it?.document} matrix={it?.matrix} table={it?.table} canvas={it?.canvas} calendar={it?.calendar} smart={it?.smart} color={(it?.properties?.icon_color as string) ?? undefined} size={14} />
                    <span className="recent-label">{it?.label ?? "…"}</span>
                  </button>
                );
              }
              const t = it?.blockTypeId ? types.find((x) => x.id === it.blockTypeId) : undefined;
              // Match the card glyph: a status block shows its current status's
              // icon/color; otherwise the type's icon/color. (A task's base type
              // color is often unset while its status colors are — using only the
              // type color made those show up gray here.)
              const schema = t?.propertySchema;
              const statusField =
                schema?.fields.find((f) => f.type === "status" && f.key === schema.status_field) ?? null;
              const status = statusField ? String(it?.properties?.[statusField.key] ?? "") : "";
              return (
                <button
                  key={`b:${e.id}`}
                  className={`menu-item recent-item${active ? " active" : ""}`}
                  onClick={() => {
                    openBlock(e.id);
                    setOpen(false);
                  }}
                >
                  <BlockIcon
                    iconKey={statusField?.optionIcons?.[status] ?? (!t || t.isText ? "type" : t.iconKey)}
                    color={statusField?.optionColors?.[status] ?? (t && !t.isText ? t.iconColor : null)}
                    size={14}
                  />
                  <span className="recent-label">{it?.label ?? "…"}</span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

/** Dynamic whole-database search: notes and collections, as you type. */
export function NavBar() {
  const { back, forward, canBack, canForward } = usePanels();
  return (
    <>
      {/* An empty strip over the page's top padding whose only job is to reveal
          the row below on hover. It holds no controls of its own, so a stray click
          up here can't trigger navigation — and it sits over padding, not content,
          so it isn't stealing clicks from anything. */}
      <div className="top-nav-zone" aria-hidden />
      <div className="top-nav">
        <button className="icon-btn" title="Back" disabled={!canBack} onClick={back}>
          <ChevronLeft size={16} />
        </button>
        <button className="icon-btn" title="Forward" disabled={!canForward} onClick={forward}>
          <ChevronRight size={16} />
        </button>
        <RecentsMenu />
      </div>
    </>
  );
}
