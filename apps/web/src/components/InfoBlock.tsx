import { CalendarDays, ChevronLeft, ChevronRight, Clock, Locate, Maximize2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Block, type BlockType } from "../api.ts";
import { oneLineText } from "../lib/display.ts";
import { BlockIcon } from "../lib/icons.tsx";
import { usePanels } from "../lib/right-panel.tsx";
import { BlockInfoPane } from "./BlockInfoPane.tsx";

const fmtDay = (date: string) =>
  new Date(`${date}T00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

interface RecentInfo {
  label: string;
  blockTypeId: string | null;
}

// Cache recent-block info so the dropdown doesn't refetch each open.
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
        }))
        .catch(() => ({ label: "(unknown)", blockTypeId: null })),
    )
    .get(id)!;

function RecentsMenu({ onPick }: { onPick: (id: string) => void }) {
  const { recents, selectedBlockId, selectedToday } = usePanels();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<Record<string, RecentInfo>>({});
  const [types, setTypes] = useState<BlockType[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    void api.get<BlockType[]>("/block-types").then(setTypes);
    recents.forEach((e) => {
      if (e.kind !== "block" || info[e.id]) return;
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
      <button className="icon-btn" title="Recently viewed" onClick={() => setOpen((o) => !o)}>
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
              const t = it?.blockTypeId ? types.find((x) => x.id === it.blockTypeId) : undefined;
              return (
                <button
                  key={`b:${e.id}`}
                  className={`menu-item recent-item${e.id === selectedBlockId && !selectedToday ? " active" : ""}`}
                  onClick={() => {
                    onPick(e.id);
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

/** The right-panel block info: navigation controls (back/origin/forward/recents/expand) + the info pane. */
export function InfoBlock({ blockId }: { blockId: string }) {
  const {
    pushBlock,
    back,
    forward,
    goOrigin,
    canBack,
    canForward,
    atOrigin,
    selectedIsCollection,
    selectedToday,
  } = usePanels();
  const nav = useNavigate();
  const fullPage = selectedToday
    ? `/today/${selectedToday}`
    : selectedIsCollection
      ? `/collections/${blockId}`
      : `/block/${blockId}`;

  return (
    <div className="info-block">
      <div className="info-nav">
        <button className="icon-btn" title="Back" disabled={!canBack} onClick={back}>
          <ChevronLeft size={16} />
        </button>
        <button
          className="icon-btn"
          title="Return to the on-screen block"
          disabled={atOrigin}
          onClick={goOrigin}
        >
          <Locate size={15} />
        </button>
        <button className="icon-btn" title="Forward" disabled={!canForward} onClick={forward}>
          <ChevronRight size={16} />
        </button>
        <span style={{ flex: 1 }} />
        <RecentsMenu onPick={pushBlock} />
        <button className="icon-btn" title="Open as full page" onClick={() => nav(fullPage)}>
          <Maximize2 size={14} />
        </button>
      </div>
      <BlockInfoPane
        blockId={blockId}
        onSelect={pushBlock}
        onSelectCollection={(id) => pushBlock(id, { collection: true })}
      />
    </div>
  );
}
