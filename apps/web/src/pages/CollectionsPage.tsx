import { Library } from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { api, type Collection } from "../api.ts";
import { CollectionIcon } from "../lib/icons.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { CreateCollectionModal } from "../components/CreateCollectionModal.tsx";
import { oneLineText } from "../lib/display.ts";
import { usePanels } from "../lib/right-panel.tsx";

function title(c: Collection): string {
  return oneLineText(c.properties) || "Untitled";
}

const KINDS = [
  { key: "list", label: "Lists" },
  { key: "document", label: "Documents" },
  { key: "matrix", label: "Matrices" },
] as const;

export function CollectionsPage() {
  const nav = useNavigate();
  const { bottomSlotEl, setHasContent, selectPage } = usePanels();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<Collection | null>(null);
  const [creating, setCreating] = useState(false);

  // Right-panel filter facets.
  const [q, setQ] = useState("");
  const [kinds, setKinds] = useState<Set<string>>(new Set());
  const [membership, setMembership] = useState<"" | "smart" | "manual">("");

  const load = () =>
    api
      .get<Collection[]>("/collections")
      .then(setCollections)
      .finally(() => setLoading(false));

  useEffect(() => {
    void load();
  }, []);

  // Arriving logs the page as the current location (clears any block
  // selection, so the panel shows the filter tools) and enables the slot.
  useEffect(() => {
    setHasContent(true);
    selectPage("collections");
    return () => setHasContent(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setHasContent]);

  const remove = async (c: Collection) => {
    await api.del(`/collections/${c.id}`);
    setDeleting(null);
    void load();
  };

  const toggleKind = (k: string) =>
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return collections.filter((c) => {
      if (kinds.size && !kinds.has(c.collectionKind ?? "")) return false;
      const isSmart = c.properties.membership_mode === "smart";
      if (membership === "smart" && !isSmart) return false;
      if (membership === "manual" && isSmart) return false;
      if (needle && !title(c).toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [collections, q, kinds, membership]);

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
        {(q.trim() || kinds.size > 0 || membership) && (
          <span className="hint">
            {shown.length} of {collections.length} shown
          </span>
        )}
      </div>
      {creating && <CreateCollectionModal onClose={() => setCreating(false)} />}

      {loading ? (
        <div className="hint">Loading…</div>
      ) : collections.length === 0 ? (
        <div className="hint">No collections yet.</div>
      ) : shown.length === 0 ? (
        <div className="hint">Nothing matches the filter.</div>
      ) : (
        shown.map((c) => {
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
                <CollectionIcon
                  document={c.collectionKind === "document"}
                  matrix={c.collectionKind === "matrix"}
                  smart={isSmart}
                  size={20}
                  color={iconColor}
                />
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

      {bottomSlotEl &&
        createPortal(
          <>
            <div className="panel-divider" />
            <div className="panel-h">Filter</div>
            <input
              type="text"
              placeholder="Name contains…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              style={{ marginBottom: 10 }}
            />
            <div className="segmented wrap" style={{ marginBottom: 10 }}>
              {KINDS.map((k) => (
                <button
                  key={k.key}
                  className={`seg${kinds.has(k.key) ? " active" : ""}`}
                  onClick={() => toggleKind(k.key)}
                >
                  {k.label}
                </button>
              ))}
            </div>
            <div className="segmented">
              {(
                [
                  ["", "All"],
                  ["smart", "Smart"],
                  ["manual", "Manual"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  className={`seg${membership === key ? " active" : ""}`}
                  onClick={() => setMembership(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          </>,
          bottomSlotEl,
        )}
    </>
  );
}
