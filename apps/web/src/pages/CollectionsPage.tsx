import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Collection } from "../api.ts";
import { BlockIcon } from "../lib/icons.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { CreateCollectionModal } from "../components/CreateCollectionModal.tsx";

function title(c: Collection): string {
  const t = c.properties.title;
  return (typeof t === "string" && t.trim()) || "Untitled";
}

export function CollectionsPage() {
  const nav = useNavigate();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<Collection | null>(null);
  const [creating, setCreating] = useState(false);

  const load = () =>
    api
      .get<Collection[]>("/collections")
      .then(setCollections)
      .finally(() => setLoading(false));

  useEffect(() => {
    void load();
  }, []);

  const remove = async (c: Collection) => {
    await api.del(`/collections/${c.id}`);
    setDeleting(null);
    void load();
  };

  return (
    <>
      <h1 className="page-title">Collections</h1>
      <p className="page-sub">Ordered, filterable groupings of blocks.</p>

      <div className="row" style={{ marginBottom: 18 }}>
        <button className="primary" onClick={() => setCreating(true)}>
          + New collection
        </button>
      </div>
      {creating && <CreateCollectionModal onClose={() => setCreating(false)} />}

      {loading ? (
        <div className="hint">Loading…</div>
      ) : collections.length === 0 ? (
        <div className="hint">No collections yet.</div>
      ) : (
        collections.map((c) => (
          <div className="card type-row" key={c.id}>
            <span className="icon-preview">
              <BlockIcon
                iconKey={(c.properties.icon_key as string) ?? "folder"}
                color={(c.properties.icon_color as string) ?? null}
                size={20}
              />
            </span>
            <button
              className="ghost collection-open"
              style={{ flex: 1, textAlign: "left" }}
              onClick={() => nav(`/collections/${c.id}`)}
            >
              <span className="chrome" style={{ fontSize: 14 }}>
                {title(c)}
              </span>
              <span className="hint" style={{ display: "block" }}>
                {c.collectionKind}
              </span>
            </button>
            <button className="ghost" onClick={() => setDeleting(c)}>
              Delete
            </button>
          </div>
        ))
      )}

      <ConfirmDialog
        open={deleting !== null}
        title={`Delete “${deleting ? title(deleting) : ""}”?`}
        message="The collection is removed. Blocks that aren't in any other collection return to the Inbox. This can't be undone."
        confirmLabel="Delete"
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && void remove(deleting)}
      />
    </>
  );
}
