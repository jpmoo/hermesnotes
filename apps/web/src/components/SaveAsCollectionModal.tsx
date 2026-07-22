import type { CollectionKind, FilterGroup, ListFormat } from "@hermes/shared";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Collection } from "../api.ts";

// Only the kinds that actually exist today (matrix defaults to a 2×2 grid).
const KINDS: { key: CollectionKind; label: string }[] = [
  { key: "list", label: "List" },
  { key: "document", label: "Spread" },
  { key: "matrix", label: "Matrix" },
];

const FORMATS: { key: ListFormat; label: string }[] = [
  { key: "blocks", label: "Blocks" },
  { key: "bullet", label: "Bullets" },
  { key: "ordered", label: "Ordered" },
  { key: "checklist", label: "Checklist" },
];

/** Save the current query as a new smart collection of a chosen kind. */
export function SaveAsCollectionModal({
  filter,
  onClose,
}: {
  filter: FilterGroup;
  onClose: () => void;
}) {
  const nav = useNavigate();
  const [title, setTitle] = useState("Untitled collection");
  const [kind, setKind] = useState<CollectionKind>("list");
  const [format, setFormat] = useState<ListFormat>("blocks");
  const [smartMode, setSmartMode] = useState<"dynamic" | "snapshot">("dynamic");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const c = await api.post<Collection>("/collections", {
        kind,
        title,
        membershipMode: "smart",
        smartMode,
        filterQuery: filter,
        ...(kind === "list" ? { listFormat: format } : {}),
      });
      nav(`/collections/${c.id}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Save query as collection</h2>

        <label className="field">
          <span>Name</span>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </label>

        <div className="field">
          <span className="field-label">Kind</span>
          <div className="segmented wrap">
            {KINDS.map((k) => (
              <button
                key={k.key}
                className={`seg${kind === k.key ? " active" : ""}`}
                onClick={() => setKind(k.key)}
              >
                {k.label}
              </button>
            ))}
          </div>
        </div>

        {kind === "list" && (
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
        )}

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
              : "Capture the current matches once; edit freely after."}
          </div>
        </div>

        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" onClick={() => void save()} disabled={busy}>
            {busy ? "Saving…" : "Create collection"}
          </button>
        </div>
      </div>
    </div>
  );
}
