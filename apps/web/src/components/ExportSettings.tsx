import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { api, apiBase, CLIENT_ID, type BlockType, type Collection } from "../api.ts";
import { CollectionIcon } from "../lib/icons.tsx";
import { CollectionPicker, collectionName } from "./CollectionPicker.tsx";

export { collectionName };

/** What to export: blocks of these types, members of these collections, or both. */
export interface ExportChoice {
  typeIds?: string[];
  collectionIds?: string[];
}

/**
 * Ask the server for the .zip and hand it to the browser as a download.
 *
 * Shared by the Settings card and a collection's own menu, so the two cannot
 * come to disagree about what an export is. Throws the server's own sentence
 * when there is one, because "export failed" says nothing about *why*.
 */
export async function downloadExport(choice: ExportChoice, filename: string): Promise<void> {
  const res = await fetch(`${apiBase}/export`, {
    method: "POST",
    credentials: "include",
    headers: { "x-client-id": CLIENT_ID, "content-type": "application/json" },
    body: JSON.stringify(choice),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    let said = "export failed";
    try {
      said = (JSON.parse(t) as { error?: string }).error ?? said;
    } catch {
      /* not JSON — keep the plain sentence */
    }
    throw new Error(said);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  // A collection's name can hold characters no file system accepts.
  a.download = filename.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "hermes-export.zip";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // **Released later, not now.** The click only *starts* a download; the
  // browser reads the file after this function has returned, and revoking the
  // URL first is a race some browsers lose. A minute is far longer than any of
  // them takes to begin reading, and the blob is only memory until then.
  //
  // (Not the reason an export once never arrived — that was Talaria's Mac
  // window, which had no download handling at all. See HermesWindow.swift.)
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Export blocks as an Obsidian-compatible .zip — one markdown file per block, a
 * folder per type, a folder per collection with an index of its members, and a
 * deduped attachments/ folder.
 */
export function ExportSettings() {
  const [types, setTypes] = useState<BlockType[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [chosenCollections, setChosenCollections] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .get<BlockType[]>("/block-types")
      .then((ts) => setTypes([...ts].sort((a, b) => (a.isText === b.isText ? a.name.localeCompare(b.name) : a.isText ? -1 : 1))))
      .catch(() => {});
    void api
      .get<Collection[]>("/collections")
      .then((cs) => setCollections([...cs].sort((a, b) => collectionName(a).localeCompare(collectionName(b)))))
      .catch(() => {});
  }, []);

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Types and collections are independent: either alone is a whole export.
  const count = selected.size + chosenCollections.length;

  const runExport = async () => {
    if (!count) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await downloadExport(
        { typeIds: [...selected], collectionIds: chosenCollections },
        "hermes-export.zip",
      );
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
        Download an Obsidian-compatible <code>.zip</code>: one markdown file per block, and a shared{" "}
        <code>attachments/</code> folder. Properties become YAML frontmatter (by their labels);
        connections become <code>[[wikilinks]]</code>. Choose collections, types, or both — either
        on its own is a whole export.
      </p>

      <div className="panel-h export-h">
        <CollectionIcon size={15} />
        Collections
      </div>
      <p className="hint" style={{ marginTop: 0 }}>
        A folder per collection, holding its blocks and an index that lists them in the
        collection’s order. Its layout — quadrants, columns, canvas positions — isn’t kept, because
        markdown has nowhere to put it. A block in two chosen collections is written once and linked
        from both.
      </p>
      <CollectionPicker collections={collections} value={chosenCollections} onChange={setChosenCollections} />

      <div className="panel-h">Types</div>
      <p className="hint" style={{ marginTop: 0 }}>A folder per type.</p>
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
        <button className="primary" onClick={() => void runExport()} disabled={busy || count === 0}>
          <Download size={15} />
          {busy ? "Preparing…" : count ? `Export ${count} item${count === 1 ? "" : "s"}` : "Export"}
        </button>
        {count > 0 && (
          <button
            className="ghost"
            onClick={() => {
              setSelected(new Set());
              setChosenCollections([]);
            }}
          >
            Clear
          </button>
        )}
      </div>
      {status && <div className="hint" style={{ marginTop: 10 }}>{status}</div>}
      {error && <div className="error" style={{ marginTop: 10 }}>{error}</div>}
    </div>
  );
}
