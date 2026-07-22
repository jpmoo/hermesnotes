import { ChevronLeft, ChevronRight, Clock, Locate, Maximize2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Block } from "../api.ts";
import { oneLineText } from "../lib/display.ts";
import { usePanels } from "../lib/right-panel.tsx";
import { BlockInfoPane } from "./BlockInfoPane.tsx";

// Cache recent-block labels so the dropdown doesn't refetch each open.
const labelCache = new Map<string, Promise<string>>();
const getLabel = (id: string) =>
  labelCache.get(id) ??
  labelCache
    .set(
      id,
      api
        .get<Block>(`/blocks/${id}`)
        .then((b) => oneLineText(b.properties, b.content) || "Untitled")
        .catch(() => "(unknown)"),
    )
    .get(id)!;

function RecentsMenu({ onPick }: { onPick: (id: string) => void }) {
  const { recents, selectedBlockId } = usePanels();
  const [open, setOpen] = useState(false);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    recents.forEach((id) => {
      if (labels[id]) return;
      void getLabel(id).then((l) => setLabels((m) => ({ ...m, [id]: l })));
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
              No recent blocks
            </div>
          ) : (
            recents.map((id) => (
              <button
                key={id}
                className={`menu-item${id === selectedBlockId ? " active" : ""}`}
                onClick={() => {
                  onPick(id);
                  setOpen(false);
                }}
              >
                {labels[id] ?? "…"}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** The right-panel block info: navigation controls (back/origin/forward/recents/expand) + the info pane. */
export function InfoBlock({ blockId }: { blockId: string }) {
  const { pushBlock, back, forward, goOrigin, canBack, canForward, atOrigin, selectedIsCollection } =
    usePanels();
  const nav = useNavigate();

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
        <button
          className="icon-btn"
          title="Open as full page"
          onClick={() =>
            nav(selectedIsCollection ? `/collections/${blockId}` : `/block/${blockId}`)
          }
        >
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
