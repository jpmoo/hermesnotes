import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { api, ApiError, type BlockType } from "../api.ts";
import { BlockIcon } from "../lib/icons.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { TypeBlockList } from "../components/TypeBlockList.tsx";
import { TypeEditor } from "../components/TypeEditor.tsx";

type EditorState = { mode: "new" } | { mode: "edit"; type: BlockType } | null;

export function TypesPage() {
  const [types, setTypes] = useState<BlockType[]>([]);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<EditorState>(null);
  const [deleting, setDeleting] = useState<BlockType | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .get<BlockType[]>("/block-types")
      .then(setTypes)
      .finally(() => setLoading(false));

  useEffect(() => {
    void load();
  }, []);

  const remove = async (type: BlockType) => {
    setError(null);
    try {
      await api.del(`/block-types/${type.id}`);
      setDeleting(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not delete");
      setDeleting(null);
    }
  };

  if (editor) {
    return (
      <>
        <h1 className="page-title">Block types</h1>
        <p className="page-sub">Define a type's icon and its fields (the editing form + embedding).</p>
        <TypeEditor
          initial={editor.mode === "edit" ? editor.type : null}
          onCancel={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            void load();
          }}
        />
      </>
    );
  }

  return (
    <>
      <h1 className="page-title">Block types</h1>
      <p className="page-sub">Define a type's icon and its fields (the editing form + embedding).</p>

      <div className="row" style={{ marginBottom: 18 }}>
        <button className="primary" onClick={() => setEditor({ mode: "new" })}>
          + New type
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <div className="hint">Loading…</div>
      ) : (
        types.map((t) => (
          <div key={t.id}>
            <div className="card type-row">
              <button
                className="icon-btn type-handle"
                title={openId === t.id ? "Hide blocks" : "Show blocks of this type"}
                onClick={() => setOpenId((cur) => (cur === t.id ? null : t.id))}
              >
                {openId === t.id ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              </button>
              <span className="icon-preview">
                <BlockIcon iconKey={t.isText ? "type" : t.iconKey} color={t.iconColor} size={20} />
              </span>
              <div style={{ flex: 1 }}>
                <div className="chrome" style={{ fontSize: 14, textTransform: "capitalize" }}>
                  {t.name}
                  {t.isText && <span className="pill" style={{ marginLeft: 8 }}>built-in</span>}
                </div>
                <div className="hint">
                  {t.isText
                    ? "Free-form markdown text (body labelled “Body”)"
                    : `${t.propertySchema?.fields.length ?? 0} field(s)`}
                </div>
              </div>
              {!t.isText && (
                <>
                  <button className="ghost" onClick={() => setEditor({ mode: "edit", type: t })}>
                    Edit
                  </button>
                  <button className="ghost" onClick={() => setDeleting(t)}>
                    Delete
                  </button>
                </>
              )}
            </div>
            {openId === t.id && <TypeBlockList type={t} />}
          </div>
        ))
      )}

      <ConfirmDialog
        open={deleting !== null}
        title={`Delete “${deleting?.name}” type?`}
        message="Only allowed if no blocks use this type. This can't be undone."
        confirmLabel="Delete"
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && void remove(deleting)}
      />
    </>
  );
}
