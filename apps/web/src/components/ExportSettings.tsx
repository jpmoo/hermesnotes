import { Download } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, apiBase, CLIENT_ID, type BlockType, type Collection } from "../api.ts";

/** What to export: blocks of these types, members of these collections, or both. */
export interface ExportChoice {
  typeIds?: string[];
  collectionIds?: string[];
}

/** A collection's name as its page shows it. */
export const collectionName = (c: Pick<Collection, "properties">): string => {
  const title = c.properties?.title;
  return typeof title === "string" && title.trim() ? title.trim() : "Untitled collection";
};

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
  URL.revokeObjectURL(url);
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
  const [chosenCollections, setChosenCollections] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
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

  const toggleIn = (set: (f: (s: Set<string>) => Set<string>) => void, id: string) =>
    set((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // A library can hold a great many collections, and a checklist nobody can
  // search is one nobody finds anything in.
  const shownCollections = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? collections.filter((c) => collectionName(c).toLowerCase().includes(q)) : collections;
  }, [collections, filter]);

  const count = selected.size + chosenCollections.size;

  const runExport = async () => {
    if (!count) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await downloadExport(
        { typeIds: [...selected], collectionIds: [...chosenCollections] },
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
        connections become <code>[[wikilinks]]</code>. Choose types, collections, or both.
      </p>

      <div className="panel-h">Types</div>
      <p className="hint" style={{ marginTop: 0 }}>A folder per type.</p>
      <div className="export-types">
        {types.map((t) => (
          <label key={t.id} className="export-type">
            <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggleIn(setSelected, t.id)} />
            <span style={{ textTransform: "capitalize" }}>{t.name}</span>
            {t.isText && (
              <span className="hint"> — text notes (incl. non-empty daily & weekly reflections)</span>
            )}
          </label>
        ))}
        {types.length === 0 && <div className="hint">No types.</div>}
      </div>

      <div className="panel-h">Collections</div>
      <p className="hint" style={{ marginTop: 0 }}>
        A folder per collection, holding its blocks and an index that lists them in the
        collection’s order. Its layout — quadrants, columns, canvas positions — isn’t kept, because
        markdown has nowhere to put it. A block chosen twice is written once and linked from both.
      </p>
      {collections.length > 12 && (
        <input
          type="search"
          className="export-filter"
          placeholder="Find a collection…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      )}
      <div className="export-types">
        {shownCollections.map((c) => (
          <label key={c.id} className="export-type">
            <input
              type="checkbox"
              checked={chosenCollections.has(c.id)}
              onChange={() => toggleIn(setChosenCollections, c.id)}
            />
            <span>{collectionName(c)}</span>
            <span className="hint"> — {c.collectionKind}</span>
          </label>
        ))}
        {collections.length === 0 && <div className="hint">No collections.</div>}
        {collections.length > 0 && shownCollections.length === 0 && (
          <div className="hint">No collection matches that.</div>
        )}
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
              setChosenCollections(new Set());
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
