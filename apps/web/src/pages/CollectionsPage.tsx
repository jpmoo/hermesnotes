import { Library, List, ListFilter } from "lucide-react";
import { useState, type CSSProperties } from "react";
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Collection } from "../api.ts";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { CreateCollectionModal } from "../components/CreateCollectionModal.tsx";
import { oneLineText } from "../lib/display.ts";

function title(c: Collection): string {
  return oneLineText(c.properties) || "Untitled";
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
      <h1 className="page-title title-with-icon">
        <Library size={22} color="#26282b" />
        Collections
      </h1>
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
        collections.map((c) => {
          const bg = c.properties.bg_color as string | undefined;
          const text = c.properties.text_color as string | undefined;
          const style: CSSProperties = {};
          if (bg) style.background = bg;
          if (text) style.color = text;
          const isSmart = c.properties.membership_mode === "smart";
          const smartMode = (c.properties.smart_mode as string) ?? "dynamic";
          const meta = isSmart ? `Smart · ${smartMode}` : "Manual";
          const iconColor = (c.properties.icon_color as string) ?? undefined;
          return (
            <div className="card type-row" key={c.id} style={style}>
              <span className="icon-preview" title={meta}>
                {isSmart ? (
                  <ListFilter size={20} color={iconColor} />
                ) : (
                  <List size={20} color={iconColor} />
                )}
              </span>
              <button
                className="ghost collection-open"
                style={{ flex: 1, textAlign: "left", color: text ?? undefined }}
                onClick={() => nav(`/collections/${c.id}`)}
              >
                <span className="chrome collection-name">{title(c)}</span>
                <span className="hint collection-meta" style={{ color: text ?? undefined }}>
                  {meta} · {c.collectionKind}
                </span>
              </button>

              <button
                className="ghost"
                style={{ color: text ?? undefined }}
                onClick={() => setDeleting(c)}
              >
                Delete
              </button>
            </div>
          );
        })
      )}

      <ConfirmDialog
        open={deleting !== null}
        title={`Delete “${deleting ? title(deleting) : ""}”?`}
        message="The collection is removed. Blocks that aren't in any other collection become Unattached. This can't be undone."
        confirmLabel="Delete"
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && void remove(deleting)}
      />
    </>
  );
}
