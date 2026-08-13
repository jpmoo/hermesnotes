import type { FilterGroup } from "@hermes/shared";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type BlockType, type Collection } from "../api.ts";
import { emptyGroup } from "../lib/filter.ts";
import { QueryBuilder } from "./QueryBuilder.tsx";

export function CreateCollectionModal({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const [title, setTitle] = useState("Untitled");
  const [kind, setKind] = useState<
    "list" | "document" | "matrix" | "table" | "canvas" | "calendar" | "rollup"
  >("list");
  const [cols, setCols] = useState(2);
  const [rows, setRows] = useState(2);
  const [mode, setMode] = useState<"explicit" | "smart">("explicit");
  const [smartMode, setSmartMode] = useState<"dynamic" | "snapshot">("dynamic");
  const [filter, setFilter] = useState<FilterGroup>(emptyGroup());
  const [types, setTypes] = useState<BlockType[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.get<BlockType[]>("/block-types").then(setTypes);
    void api.get<{ name: string }[]>("/tags").then((t) => setTags(t.map((x) => x.name)));
  }, []);

  // A ref, not the busy flag: setBusy only schedules a re-render, so two clicks
  // arriving in the same frame both find the button still enabled and both
  // create a collection. This one is set the instant the first click runs.
  const creating = useRef(false);
  const create = async () => {
    if (creating.current) return;
    creating.current = true;
    setBusy(true);
    try {
      const c = await api.post<Collection>("/collections", {
        kind,
        title,
        membershipMode: kind === "canvas" || kind === "rollup" ? "explicit" : mode,
        ...(kind !== "canvas" && kind !== "rollup" && mode === "smart"
          ? { smartMode, filterQuery: filter }
          : {}),
        ...(kind === "matrix" ? { matrixCols: cols, matrixRows: rows } : {}),
      });
      // The modal is mounted in the sidebar, which outlives route changes —
      // navigation alone doesn't unmount it.
      onClose();
      nav(`/collections/${c.id}`);
    } finally {
      creating.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 540 }} onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">New collection</h2>

        <label className="field">
          <span>Name</span>
          <input
            type="text"
            autoComplete="off"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>

        <div className="field">
          <span className="field-label">Kind</span>
          <div className="segmented">
            <button className={`seg${kind === "list" ? " active" : ""}`} onClick={() => setKind("list")}>
              List
            </button>
            <button
              className={`seg${kind === "document" ? " active" : ""}`}
              onClick={() => setKind("document")}
            >
              Spread
            </button>
            <button
              className={`seg${kind === "matrix" ? " active" : ""}`}
              onClick={() => setKind("matrix")}
            >
              Matrix
            </button>
            <button
              className={`seg${kind === "table" ? " active" : ""}`}
              onClick={() => setKind("table")}
            >
              Table
            </button>
            <button
              className={`seg${kind === "canvas" ? " active" : ""}`}
              onClick={() => setKind("canvas")}
            >
              Canvas
            </button>
            <button
              className={`seg${kind === "calendar" ? " active" : ""}`}
              onClick={() => {
                setKind("calendar");
                setMode("smart");
              }}
            >
              Calendar
            </button>
            <button
              className={`seg${kind === "rollup" ? " active" : ""}`}
              onClick={() => setKind("rollup")}
            >
              Rollup
            </button>
          </div>
          <div className="hint" style={{ marginTop: 6 }}>
            {kind === "list"
              ? "A one-line-per-item list (bullet, ordered, checklist, or blocks)."
              : kind === "document"
                ? "Full-card sections you arrange with the layout tool in the right panel."
                : kind === "matrix"
                  ? "An x/y grid of regions (Eisenhower 2×2, Kanban 3×1…) — drag blocks in from a drawer."
                  : kind === "table"
                    ? "A spreadsheet-style grid: one row per block, property columns you pick, inline editing."
                    : kind === "canvas"
                      ? "An infinite field: drop blocks anywhere, connect them with lines, zoom and pan. Add manually and by query at once."
                      : kind === "calendar"
                        ? "A month / week / 3-day calendar. A saved query feeds it; cards land on the days their date or datespan fields point to."
                        : "What's nested under what: a heading per project, say, with its tasks beneath it. Set the top level and what hangs off it in the right panel — it holds nothing itself."}
          </div>
        </div>

        {kind === "matrix" && (
          <div className="field">
            <span className="field-label">Grid</span>
            <div className="row" style={{ gap: 16 }}>
              <label className="row" style={{ gap: 6 }}>
                <span className="hint">Columns</span>
                <input
                  type="number"
                  min={1}
                  max={6}
                  value={cols}
                  style={{ width: 72 }}
                  onChange={(e) => setCols(Math.min(6, Math.max(1, Number(e.target.value) || 1)))}
                />
              </label>
              <label className="row" style={{ gap: 6 }}>
                <span className="hint">Rows</span>
                <input
                  type="number"
                  min={1}
                  max={6}
                  value={rows}
                  style={{ width: 72 }}
                  onChange={(e) => setRows(Math.min(6, Math.max(1, Number(e.target.value) || 1)))}
                />
              </label>
            </div>
          </div>
        )}

        {kind === "canvas" ? (
          <div className="hint" style={{ marginBottom: 14 }}>
            Add blocks on the canvas itself: drop them manually, or build a query in the right
            panel and Apply to place the matches.
          </div>
        ) : kind === "rollup" ? (
          <div className="hint" style={{ marginBottom: 14 }}>
            A rollup holds nothing of its own — it shows blocks where they already are. Choose the
            top level and what hangs off it in the right panel once it opens.
          </div>
        ) : (
        <div className="field">
          <span className="field-label">Membership</span>
          <div className="segmented">
            <button className={`seg${mode === "explicit" ? " active" : ""}`} onClick={() => setMode("explicit")}>
              Manual
            </button>
            <button className={`seg${mode === "smart" ? " active" : ""}`} onClick={() => setMode("smart")}>
              Smart
            </button>
          </div>
          <div className="hint" style={{ marginTop: 6 }}>
            {mode === "explicit"
              ? "Add blocks yourself — search existing or create new."
              : "Blocks are selected by a query."}
          </div>
        </div>
        )}

        {kind !== "canvas" && kind !== "rollup" && mode === "smart" && (
          <>
            <div className="field">
              <span className="field-label">Updates</span>
              <div className="segmented">
                <button
                  className={`seg${smartMode === "dynamic" ? " active" : ""}`}
                  onClick={() => setSmartMode("dynamic")}
                >
                  Dynamic
                </button>
                <button
                  className={`seg${smartMode === "snapshot" ? " active" : ""}`}
                  onClick={() => setSmartMode("snapshot")}
                >
                  Snapshot
                </button>
              </div>
              <div className="hint" style={{ marginTop: 6 }}>
                {smartMode === "dynamic"
                  ? "Membership always reflects the query as blocks change."
                  : "Capture the current matches once; edit the list freely after."}
              </div>
            </div>
            <div className="field">
              <span className="field-label">Query</span>
              <QueryBuilder value={filter} onChange={setFilter} types={types} tags={tags} />
            </div>
          </>
        )}

        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" onClick={() => void create()} disabled={busy}>
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
