import { CalendarDays, ChevronLeft, ChevronRight, Clock, Layers, Library, Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Block, type BlockType } from "../api.ts";
import { oneLineText } from "../lib/display.ts";
import { BlockIcon, CollectionIcon } from "../lib/icons.tsx";
import { usePanels } from "../lib/right-panel.tsx";

const fmtDay = (date: string) =>
  new Date(`${date}T00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

interface RecentInfo {
  label: string;
  blockTypeId: string | null;
  document?: boolean;
  matrix?: boolean;
  table?: boolean;
  canvas?: boolean;
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
          document: b.collectionKind === "document",
          matrix: b.collectionKind === "matrix",
          table: b.collectionKind === "table",
          canvas: b.collectionKind === "canvas",
          smart: (b.properties as Record<string, unknown>)?.membership_mode === "smart",
        }))
        .catch(() => ({ label: "(unknown)", blockTypeId: null })),
    )
    .get(id)!;

function RecentsMenu() {
  const { recents, selectedBlockId, selectedToday, openBlock } = usePanels();
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
                const meta = {
                  blocks: { icon: <Layers size={14} />, label: "All blocks" },
                  collections: { icon: <Library size={14} />, label: "Collections" },
                  favorites: { icon: <Star size={14} />, label: "Favorites" },
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
                    {meta.icon}
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
                    <CalendarDays size={14} />
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
                    <CollectionIcon document={it?.document} matrix={it?.matrix} table={it?.table} canvas={it?.canvas} smart={it?.smart} size={14} />
                    <span className="recent-label">{it?.label ?? "…"}</span>
                  </button>
                );
              }
              const t = it?.blockTypeId ? types.find((x) => x.id === it.blockTypeId) : undefined;
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
                    iconKey={!t || t.isText ? "type" : t.iconKey}
                    color={t && !t.isText ? t.iconColor : null}
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
    <div className="top-nav">
      <button className="icon-btn" title="Back" disabled={!canBack} onClick={back}>
        <ChevronLeft size={16} />
      </button>
      <button className="icon-btn" title="Forward" disabled={!canForward} onClick={forward}>
        <ChevronRight size={16} />
      </button>
      <RecentsMenu />
    </div>
  );
}
