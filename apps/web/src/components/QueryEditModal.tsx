import type { FilterGroup } from "@hermes/shared";
import { useEffect, useState } from "react";
import { api, type BlockType } from "../api.ts";
import { normalizeFilter } from "../lib/filter.ts";
import { QueryBuilder } from "./QueryBuilder.tsx";

export function QueryEditModal({
  collectionId,
  initial,
  onClose,
  onSaved,
}: {
  collectionId: string;
  initial: unknown;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [filter, setFilter] = useState<FilterGroup>(() => normalizeFilter(initial));
  const [types, setTypes] = useState<BlockType[]>([]);
  const [tags, setTags] = useState<string[]>([]);

  useEffect(() => {
    void api.get<BlockType[]>("/block-types").then(setTypes);
    void api.get<{ name: string }[]>("/tags").then((t) => setTags(t.map((x) => x.name)));
  }, []);

  const save = async () => {
    await api.patch(`/collections/${collectionId}`, { filter_query: filter });
    onSaved();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 540 }} onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Edit query</h2>
        <QueryBuilder value={filter} onChange={setFilter} types={types} tags={tags} />
        <div className="modal-actions" style={{ marginTop: 12 }}>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
