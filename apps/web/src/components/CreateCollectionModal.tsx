import type { FilterGroup } from "@hermes/shared";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type BlockType, type Collection } from "../api.ts";
import { emptyGroup } from "../lib/filter.ts";
import { QueryBuilder } from "./QueryBuilder.tsx";

export function CreateCollectionModal({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const [title, setTitle] = useState("Untitled");
  const [kind, setKind] = useState<"list" | "document" | "matrix" | "table" | "canvas">("list");
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

  const create = async () => {
    setBusy(true);
    try {
      const c = await api.post<Collection>("/collections", {
        kind,
        title,
        membershipMode: kind === "canvas" ? "explicit" : mode,
        ...(kind === "canvas"
          ? filter.items.length > 0
            ? { filterQuery: filter }
            : {}
          : mode === "smart"
            ? { smartMode, filterQuery: filter }
            : {}),
        ...(kind === "matrix" ? { matrixCols: cols, matrixRows: rows } : {}),
      });
      // The modal is mounted in the sidebar, which outlives route changes —
      // navigation alone doesn't unmount it.
      onClose();
      nav(`/collections/${c.id}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 540 }} onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">New collection</h2>

        <label className="field">
          <span>Name</span>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
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
                    : "An infinite field: drop blocks anywhere, connect them with lines, zoom and pan. Add manually and by query at once."}
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
          <div className="field">
            <span className="field-label">Feed from a query (optional)</span>
            <div className="hint" style={{ marginBottom: 6 }}>
              Matching blocks land on the canvas automatically — you can still drop blocks manually too.
            </div>
            <QueryBuilder value={filter} onChange={setFilter} types={types} tags={tags} />
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

        {kind !== "canvas" && mode === "smart" && (
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
