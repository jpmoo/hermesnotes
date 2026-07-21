import type { FilterGroup, ListFormat } from "@hermes/shared";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Collection } from "../api.ts";

const FORMATS: { key: ListFormat; label: string }[] = [
  { key: "blocks", label: "Blocks" },
  { key: "bullet", label: "Bullets" },
  { key: "ordered", label: "Ordered" },
  { key: "checklist", label: "Checklist" },
];

/** Save the current All-blocks query as a new smart list collection. */
export function SaveAsListModal({
  filter,
  onClose,
}: {
  filter: FilterGroup;
  onClose: () => void;
}) {
  const nav = useNavigate();
  const [title, setTitle] = useState("Untitled list");
  const [format, setFormat] = useState<ListFormat>("blocks");
  const [smartMode, setSmartMode] = useState<"dynamic" | "snapshot">("dynamic");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const c = await api.post<Collection>("/collections", {
        kind: "list",
        title,
        membershipMode: "smart",
        smartMode,
        filterQuery: filter,
        listFormat: format,
      });
      nav(`/collections/${c.id}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Save query as list</h2>

        <label className="field">
          <span>Name</span>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </label>

        <div className="field">
          <span className="field-label">Format</span>
          <div className="segmented">
            {FORMATS.map((f) => (
              <button
                key={f.key}
                className={`seg${format === f.key ? " active" : ""}`}
                onClick={() => setFormat(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

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

        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" onClick={() => void save()} disabled={busy}>
            {busy ? "Saving…" : "Create list"}
          </button>
        </div>
      </div>
    </div>
  );
}
