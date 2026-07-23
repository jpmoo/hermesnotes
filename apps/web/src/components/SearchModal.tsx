import { CalendarDays, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type BlockType, type SearchHit } from "../api.ts";
import { BlockIcon, CollectionIcon } from "../lib/icons.tsx";
import { usePanels } from "../lib/right-panel.tsx";

const fmtDay = (date: string) =>
  new Date(`${date}T00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/**
 * Universal search overlay (opened from the rail's Search button): one input,
 * live results split into keyword Matches and semantic Similar sections, each
 * row with its type/collection icon. ↑↓ + Enter navigate; Esc closes.
 */
export function SearchModal({ onClose }: { onClose: () => void }) {
  const { openBlock } = usePanels();
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [searched, setSearched] = useState(false);
  const [idx, setIdx] = useState(0);
  const [types, setTypes] = useState<BlockType[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void api.get<BlockType[]>("/block-types").then(setTypes).catch(() => {});
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      setSearched(false);
      return;
    }
    const t = setTimeout(() => {
      void api
        .get<SearchHit[]>(`/search?q=${encodeURIComponent(q)}`)
        .then((r) => {
          setResults(r);
          setSearched(true);
          setIdx(0);
        })
        .catch(() => setResults([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  const pick = (h: SearchHit) => {
    // Daily notes open their day; arriving there logs the entry.
    if (h.kind === "today" && h.date) nav(`/today/${h.date}`);
    else openBlock(h.id, { collection: h.kind === "collection" });
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
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
      onClose();
    }
  };

  const literal = results.filter((h) => !h.semantic);
  const semantic = results.filter((h) => h.semantic);

  const row = (h: SearchHit) => {
    const i = results.indexOf(h);
    const t = h.blockTypeId ? types.find((x) => x.id === h.blockTypeId) : undefined;
    return (
      <button
        key={h.id}
        className={`menu-item recent-item${i === idx ? " active" : ""}`}
        onMouseDown={(e) => {
          e.preventDefault();
          pick(h);
        }}
        onMouseEnter={() => setIdx(i)}
      >
        {h.kind === "today" ? (
          <CalendarDays size={14} />
        ) : h.kind === "collection" ? (
          <CollectionIcon
            document={h.document}
            matrix={h.matrix}
            table={h.table}
            canvas={h.canvas}
            smart={h.smart}
            size={14}
          />
        ) : (
          <BlockIcon
            iconKey={!t || t.isText ? "type" : t.iconKey}
            color={t && !t.isText ? t.iconColor : null}
            size={14}
          />
        )}
        <span className="recent-label">
          {h.kind === "today" && h.date ? `Today · ${fmtDay(h.date)} — ${h.label}` : h.label}
        </span>
      </button>
    );
  };

  return (
    <div className="modal-backdrop search-backdrop" onClick={onClose}>
      <div className="search-modal" onClick={(e) => e.stopPropagation()}>
        <div className="search-modal-input">
          <Search size={15} className="gs-icon" />
          <input
            ref={inputRef}
            className="gs-input"
            placeholder="Search everything…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        {searched && (
          <div className="search-modal-results">
            <div className="gs-sep">Matches</div>
            {literal.length === 0 ? (
              <div className="hint" style={{ padding: "4px 10px 8px" }}>
                No keyword matches.
              </div>
            ) : (
              literal.map(row)
            )}
            {semantic.length > 0 && (
              <>
                <div className="gs-sep">Similar</div>
                {semantic.map(row)}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
