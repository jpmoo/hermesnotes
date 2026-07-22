import { Library, List, ListFilter, MoreVertical } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Collection } from "../api.ts";
import { BlockIcon } from "../lib/icons.tsx";
import { ColorPickerModal } from "../components/ColorPickerModal.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { CreateCollectionModal } from "../components/CreateCollectionModal.tsx";
import { oneLineText } from "../lib/display.ts";

function title(c: Collection): string {
  return oneLineText(c.properties) || "Untitled";
}

type Target = "bg" | "text" | "icon";
const KEY: Record<Target, string> = { bg: "bg_color", text: "text_color", icon: "icon_color" };
const LABEL: Record<Target, string> = {
  bg: "Change Background Color",
  text: "Change Text Color",
  icon: "Change Icon Color",
};

export function CollectionsPage() {
  const nav = useNavigate();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<Collection | null>(null);
  const [creating, setCreating] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [colorEdit, setColorEdit] = useState<{ id: string; target: Target } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const load = () =>
    api
      .get<Collection[]>("/collections")
      .then(setCollections)
      .finally(() => setLoading(false));

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!menuFor) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuFor(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuFor]);

  const remove = async (c: Collection) => {
    await api.del(`/collections/${c.id}`);
    setDeleting(null);
    void load();
  };

  const saveColor = async (id: string, target: Target, color: string) => {
    await api.patch(`/collections/${id}`, { [KEY[target]]: color });
    setColorEdit(null);
    void load();
  };

  const editing = colorEdit
    ? collections.find((c) => c.id === colorEdit.id)?.properties[KEY[colorEdit.target]]
    : undefined;

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
          return (
            <div className="card type-row" key={c.id} style={style}>
              <span className="icon-preview">
                <BlockIcon
                  iconKey={(c.properties.icon_key as string) ?? "folder"}
                  color={(c.properties.icon_color as string) ?? null}
                  size={20}
                />
              </span>
              <button
                className="ghost collection-open"
                style={{ flex: 1, textAlign: "left", color: text ?? undefined }}
                onClick={() => nav(`/collections/${c.id}`)}
              >
                <span className="chrome" style={{ fontSize: 14 }}>
                  {title(c)}
                </span>
                <span className="hint collection-meta" style={{ color: text ?? undefined }}>
                  {isSmart ? <ListFilter size={13} /> : <List size={13} />}
                  {meta} · {c.collectionKind}
                </span>
              </button>

              <div className="nav-kebab" ref={menuFor === c.id ? menuRef : undefined}>
                <button
                  className="kebab-btn"
                  title="Colors"
                  style={{ color: text ?? undefined }}
                  onClick={() => setMenuFor(menuFor === c.id ? null : c.id)}
                >
                  <MoreVertical size={16} />
                </button>
                {menuFor === c.id && (
                  <div className="menu" style={{ right: 0 }}>
                    {(["bg", "text", "icon"] as Target[]).map((t) => (
                      <button
                        key={t}
                        className="menu-item"
                        onClick={() => {
                          setColorEdit({ id: c.id, target: t });
                          setMenuFor(null);
                        }}
                      >
                        {LABEL[t]}
                      </button>
                    ))}
                  </div>
                )}
              </div>

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

      <ColorPickerModal
        open={colorEdit !== null}
        title={colorEdit ? LABEL[colorEdit.target] : ""}
        value={typeof editing === "string" ? editing : "#5fa4b5"}
        onCancel={() => setColorEdit(null)}
        onSave={(color) => colorEdit && void saveColor(colorEdit.id, colorEdit.target, color)}
      />
    </>
  );
}
