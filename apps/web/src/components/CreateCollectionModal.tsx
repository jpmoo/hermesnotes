import type { FilterQuery } from "@hermes/shared";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type BlockType, type Collection } from "../api.ts";
import { QueryBuilder } from "./QueryBuilder.tsx";

export function CreateCollectionModal({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const [title, setTitle] = useState("Untitled list");
  const [mode, setMode] = useState<"explicit" | "smart">("explicit");
  const [smartMode, setSmartMode] = useState<"dynamic" | "snapshot">("dynamic");
  const [filter, setFilter] = useState<FilterQuery>({ match: "all", conditions: [] });
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
        kind: "list",
        title,
        membershipMode: mode,
        ...(mode === "smart" ? { smartMode, filterQuery: filter } : {}),
      });
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

        {mode === "smart" && (
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
