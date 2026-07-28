import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { api, apiBase, CLIENT_ID, type BlockType } from "../api.ts";

/**
 * Export blocks of chosen types as an Obsidian-compatible .zip — one markdown
 * file per block, one folder per type, plus a deduped attachments/ folder.
 * Collections aren't exported (they have no meaningful single-file form).
 */
export function ExportSettings() {
  const [types, setTypes] = useState<BlockType[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .get<BlockType[]>("/block-types")
      .then((ts) => setTypes([...ts].sort((a, b) => (a.isText === b.isText ? a.name.localeCompare(b.name) : a.isText ? -1 : 1))))
      .catch(() => {});
  }, []);

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const runExport = async () => {
    if (!selected.size) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch(`${apiBase}/export`, {
        method: "POST",
        credentials: "include",
        headers: { "x-client-id": CLIENT_ID, "content-type": "application/json" },
        body: JSON.stringify({ typeIds: [...selected] }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(t ? (JSON.parse(t).error ?? "export failed") : "export failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "hermes-export.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus("Export downloaded.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "export failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="panel-h" style={{ marginTop: 0 }}>Export to Markdown</div>
      <p className="hint" style={{ marginTop: 0 }}>
        Download an Obsidian-compatible <code>.zip</code>: one markdown file per block, a folder per
        type, and a shared <code>attachments/</code> folder. Properties become YAML frontmatter (by
        their labels); connections become <code>[[wikilinks]]</code>. Collections aren’t exported.
      </p>

      <div className="export-types">
        {types.map((t) => (
          <label key={t.id} className="export-type">
            <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggle(t.id)} />
            <span style={{ textTransform: "capitalize" }}>{t.name}</span>
            {t.isText && (
              <span className="hint"> — text notes (incl. non-empty daily & weekly reflections)</span>
            )}
          </label>
        ))}
        {types.length === 0 && <div className="hint">No types.</div>}
      </div>

      <div className="row" style={{ marginTop: 14, alignItems: "center", gap: 12 }}>
        <button className="primary" onClick={() => void runExport()} disabled={busy || selected.size === 0}>
          <Download size={15} />
          {busy ? "Preparing…" : `Export ${selected.size || ""} type${selected.size === 1 ? "" : "s"}`.trim()}
        </button>
        {types.length > 0 && (
          <button
            className="ghost"
            onClick={() => setSelected((s) => (s.size === types.length ? new Set() : new Set(types.map((t) => t.id))))}
          >
            {selected.size === types.length ? "Clear" : "Select all"}
          </button>
        )}
      </div>
      {status && <div className="hint" style={{ marginTop: 10 }}>{status}</div>}
      {error && <div className="error" style={{ marginTop: 10 }}>{error}</div>}
    </div>
  );
}
