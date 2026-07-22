import { CalendarDays, ChevronLeft, ChevronRight, Clock, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Block, type BlockType, type SearchHit } from "../api.ts";
import { oneLineText } from "../lib/display.ts";
import { BlockIcon, CollectionIcon } from "../lib/icons.tsx";
import { usePanels } from "../lib/right-panel.tsx";

const fmtDay = (date: string) =>
  new Date(`${date}T00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

interface RecentInfo {
  label: string;
  blockTypeId: string | null;
  document?: boolean;
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
      if (e.kind === "today" || info[e.id]) return;
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
                    <CollectionIcon document={it?.document} smart={it?.smart} size={14} />
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
function GlobalSearch() {
  const { openBlock } = usePanels();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const [types, setTypes] = useState<BlockType[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api.get<BlockType[]>("/block-types").then(setTypes).catch(() => {});
  }, []);

  useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      setOpen(false);
      return;
    }
    const t = setTimeout(() => {
      void api
        .get<SearchHit[]>(`/search?q=${encodeURIComponent(q)}`)
        .then((r) => {
          setResults(r);
          setOpen(true);
          setIdx(0);
        })
        .catch(() => setResults([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const pick = (h: SearchHit) => {
    openBlock(h.id, { collection: h.kind === "collection" });
    setOpen(false);
    setQ("");
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      const h = results[idx];
      if (h) pick(h);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="global-search" ref={boxRef}>
      <Search size={14} className="gs-icon" />
      <input
        className="gs-input"
        placeholder="Search everything…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => {
          if (results.length) setOpen(true);
        }}
      />
      {open && (
        <div className="menu gs-menu">
          {results.length === 0 ? (
            <div className="hint" style={{ padding: "6px 10px" }}>
              No matches
            </div>
          ) : (
            results.map((h, i) => {
              const t = h.blockTypeId ? types.find((x) => x.id === h.blockTypeId) : undefined;
              const firstSemantic = h.semantic && (i === 0 || !results[i - 1]!.semantic);
              return (
                <div key={h.id}>
                  {firstSemantic && <div className="gs-sep">Similar</div>}
                  <button
                    className={`menu-item recent-item${i === idx ? " active" : ""}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pick(h);
                    }}
                  >
                    {h.kind === "collection" ? (
                      <CollectionIcon document={h.document} smart={h.smart} size={14} />
                    ) : (
                      <BlockIcon
                        iconKey={!t || t.isText ? "type" : t.iconKey}
                        color={t && !t.isText ? t.iconColor : null}
                        size={14}
                      />
                    )}
                    <span className="recent-label">{h.label}</span>
                  </button>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

/** Global navigation cluster: back / forward / history + search, top of the window. */
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
      <GlobalSearch />
    </div>
  );
}
