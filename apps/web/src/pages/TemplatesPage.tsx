import { templateName } from "@hermes/shared";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  FileType2,
  Plus,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type Block } from "../api.ts";
import { Banner, BannerAddButton, type BannerValue } from "../components/Banner.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { LongTextField } from "../components/LongTextField.tsx";
import { usePanels } from "../lib/right-panel.tsx";
import { usePreferences } from "../lib/preferences.tsx";

/**
 * Templates: named prose kept ready to drop into any long-text field.
 *
 * Each one edits in place — the same markdown surface it will be pasted into,
 * so what you see here is what lands there, mentions and all. A line holding
 * nothing but a slash marks where the caret should go once it's been applied.
 */
function TemplateRow({
  block,
  open,
  onToggle,
  onDeleted,
}: {
  block: Block;
  open: boolean;
  onToggle: () => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(templateName(block.properties) ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const nameTimer = useRef<ReturnType<typeof setTimeout>>();
  const bodyTimer = useRef<ReturnType<typeof setTimeout>>();

  const rename = (v: string) => {
    setName(v);
    if (nameTimer.current) clearTimeout(nameTimer.current);
    nameTimer.current = setTimeout(() => {
      void api.patch(`/templates/${block.id}`, { name: v.trim() || "Untitled" });
    }, 600);
  };
  const rewrite = (v: string) => {
    if (bodyTimer.current) clearTimeout(bodyTimer.current);
    bodyTimer.current = setTimeout(() => {
      void api.patch(`/templates/${block.id}`, { content: v });
    }, 700);
  };

  return (
    <div className="card tpl-row">
      <div className="tpl-head">
        <button className="icon-btn" title={open ? "Collapse" : "Expand"} onClick={onToggle}>
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
        <input
          className="tpl-name"
          value={name}
          placeholder="Template name"
          autoComplete="off"
          onChange={(e) => rename(e.target.value)}
        />
        <button className="icon-btn danger-hover" title="Delete" onClick={() => setConfirmDelete(true)}>
          <Trash2 size={15} />
        </button>
      </div>
      {open && (
        <div className="tpl-body">
          <LongTextField
            value={block.content ?? ""}
            onChange={rewrite}
            placeholder="Write the template…"
            blockId={block.id}
          />
          <div className="hint tpl-hint">
            There are a couple of marks that you can use. They need to be entered on their own
            line, with no other text on that line before or after. <code>/</code> is where the
            caret lands when the field is opened — put it under the heading you actually want to
            write beneath. <code>%</code> is where text sent forward from the last daily note or
            weekly reflection arrives; without one it arrives at the very top, and if nothing came
            through, the note says so where it would have gone. Both are used up when the template
            is applied, so neither shows in the note.
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirmDelete}
        title={`Delete “${name || "this template"}”?`}
        message="Anywhere it's already been applied keeps the text — this only removes the template itself. It can't be undone."
        confirmLabel="Delete"
        danger
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          void api.del(`/templates/${block.id}`).then(onDeleted);
        }}
      />
    </div>
  );
}

export function TemplatesPage() {
  const [rows, setRows] = useState<Block[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const { selectPage } = usePanels();
  const { banner, setBanner } = usePreferences();

  const load = () =>
    api
      .get<Block[]>("/templates")
      .then(setRows)
      .finally(() => setLoading(false));

  useEffect(() => {
    void load();
    selectPage("templates");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = async () => {
    const b = await api.post<Block>("/templates", { name: "Untitled template", content: "" });
    setOpen((o) => ({ ...o, [b.id]: true }));
    await load();
  };

  const allOpen = rows.length > 0 && rows.every((r) => open[r.id] ?? false);
  const toggleAll = () =>
    setOpen(Object.fromEntries(rows.map((r) => [r.id, !allOpen])));

  return (
    <>
      {(banner("templates") as BannerValue | null) && (
        <Banner
          value={banner("templates") as BannerValue}
          editable
          onChange={(v) => setBanner("templates", v)}
        />
      )}
      <div className="page-head">
        <h1 className="page-title title-with-icon">
          <FileType2 size={22} color="#26282b" />
          Templates
        </h1>
        {!banner("templates") && (
          <BannerAddButton className="page-head-add" onAdded={(v) => setBanner("templates", v)} />
        )}
      </div>
      <p className="page-sub">
        Prose you keep reaching for. Right-click in any long-text field to apply one — a line with
        just a slash in it marks where the caret should land.
      </p>

      <div className="row" style={{ marginBottom: 14, gap: 12 }}>
        <button className="primary" onClick={() => void create()}>
          <Plus size={15} /> New template
        </button>
        {rows.length > 0 && (
          <button className="bar-btn" onClick={toggleAll}>
            {allOpen ? <ChevronsDownUp size={13} /> : <ChevronsUpDown size={13} />}
            {allOpen ? "Collapse all" : "Expand all"}
          </button>
        )}
        <span className="hint">{rows.length} template(s)</span>
      </div>

      {loading ? (
        <div className="hint">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="hint">No templates yet.</div>
      ) : (
        <div className="block-stack">
          {rows.map((r) => (
            <TemplateRow
              key={r.id}
              block={r}
              open={open[r.id] ?? false}
              onToggle={() => setOpen((o) => ({ ...o, [r.id]: !(o[r.id] ?? false) }))}
              onDeleted={() => void load()}
            />
          ))}
        </div>
      )}
    </>
  );
}
