import { useEffect, useState } from "react";
import { api, type BlockSearchResult, type BlockType } from "../api.ts";
import { BlockIcon } from "../lib/icons.tsx";
import { firstLineHtml } from "../lib/markdown-excerpt.ts";

/** Search existing blocks and add them to a collection (manual membership). */
export function FinderModal({
  collectionId,
  types,
  onClose,
  onAdded,
}: {
  collectionId: string;
  types: BlockType[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<BlockSearchResult[]>([]);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const typeById = new Map(types.map((t) => [t.id, t]));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const t = setTimeout(() => {
      void api
        .get<BlockSearchResult[]>(
          `/blocks/search?excludeCollectionId=${collectionId}&q=${encodeURIComponent(q)}`,
        )
        .then(setResults)
        .catch(() => setResults([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q, collectionId]);

  const add = async (r: BlockSearchResult) => {
    setAdded((s) => new Set(s).add(r.id));
    await api.post(`/collections/${collectionId}/members`, { blockId: r.id });
    onAdded();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card finder" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Add existing blocks</h2>
        <input
          type="text"
          placeholder="Search your blocks…"
          value={q}
          autoFocus
          onChange={(e) => setQ(e.target.value)}
          style={{ marginBottom: 12 }}
        />
        <div className="finder-results">
          {results.length === 0 ? (
            <div className="hint" style={{ padding: "8px 4px" }}>
              No matching blocks.
            </div>
          ) : (
            results.map((r) => {
              const type = r.blockTypeId ? typeById.get(r.blockTypeId) : undefined;
              return (
                <div className="finder-row" key={r.id}>
                  <BlockIcon
                    iconKey={type ? (type.isText ? "type" : type.iconKey) : "type"}
                    color={type?.iconColor}
                    size={16}
                  />
                  <span
                    className="finder-label li-md"
                    dangerouslySetInnerHTML={{ __html: firstLineHtml(r.label) }}
                  />
                  <button
                    className="ghost"
                    disabled={added.has(r.id)}
                    onClick={() => void add(r)}
                  >
                    {added.has(r.id) ? "Added" : "Add"}
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div className="modal-actions" style={{ marginTop: 12 }}>
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
