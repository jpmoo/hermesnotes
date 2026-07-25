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
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
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

      <div className="row" style={{ marginBottom: 18, gap: 12 }}>
        <button className="primary" onClick={() => setEditor({ mode: "new" })}>
          + New type
        </button>
        {types.length > 0 && (
          <button
            className="ghost"
            onClick={() =>
              setOpenIds((cur) =>
                cur.size === types.length ? new Set() : new Set(types.map((t) => t.id)),
              )
            }
          >
            {openIds.size === types.length ? "Collapse all" : "Expand all"}
          </button>
        )}
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
                title={openIds.has(t.id) ? "Hide blocks" : "Show blocks of this type"}
                onClick={() =>
                  setOpenIds((cur) => {
                    const next = new Set(cur);
                    if (next.has(t.id)) next.delete(t.id);
                    else next.add(t.id);
                    return next;
                  })
                }
              >
                {openIds.has(t.id) ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              </button>
              <span className="icon-preview">
                <BlockIcon iconKey={t.isText ? "type" : t.iconKey} color={t.iconColor} size={20} />
              </span>
              <div style={{ flex: 1 }}>
                <div className="chrome" style={{ fontSize: 14, textTransform: "capitalize" }}>
                  {t.name}
                  {t.builtin && <span className="pill" style={{ marginLeft: 8 }}>built in</span>}
                </div>
                <div className="hint">
                  {t.propertySchema?.fields.length ?? 0} field(s) · {t.blockCount ?? 0} block(s)
                </div>
              </div>
              <button className="ghost" onClick={() => setEditor({ mode: "edit", type: t })}>
                Edit
              </button>
              {!t.builtin && (
                <button className="ghost" onClick={() => setDeleting(t)}>
                  Delete
                </button>
              )}
            </div>
            {openIds.has(t.id) && <TypeBlockList type={t} />}
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
