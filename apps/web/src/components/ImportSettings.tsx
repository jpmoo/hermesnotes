import { FolderOpen, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, apiBase, CLIENT_ID } from "../api.ts";
import {
  buildIndex,
  parseNote,
  planImport,
  type ImportPlan,
  type PlannedNote,
} from "@hermes/shared";

/**
 * Import an Obsidian vault.
 *
 * The whole vault is picked, not the folder being imported. That is not a
 * convenience: a note in one folder writes `![[A Boat.excalidraw]]` for a file
 * three folders away, and Obsidian resolves a bare name against every file
 * there is. Given only the folder, that embed resolves to nothing and the file
 * never arrives. So the picker takes the vault and a second control says which
 * folder becomes notes — everything else is there to be linked and attached.
 *
 * Nothing is written until somebody has read what will be. The scan is done
 * here, in the browser, from files already in memory, and shown in full.
 */

/** A file the picker handed us, keyed by its vault-relative path. */
type Picked = Map<string, File>;

const relPath = (f: File) => {
  const p = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
  // The picker prefixes everything with the chosen folder's own name; the vault
  // root is what a wikilink is relative to, so that first segment comes off.
  return p.split("/").slice(1).join("/");
};

const IMG = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;

/**
 * The line in a run collection's description saying what it is.
 *
 * Each import makes a list holding everything it created. That list *is* the
 * undo: archiving a collection offers to take its blocks with it, so an import
 * needs no undo of its own — and the general feature is the better one, because
 * "these arrived together" is true of more than imports.
 */
const RUN_MARK = "Imported from Obsidian";


export function ImportSettings() {
  const [picked, setPicked] = useState<Picked>(new Map());
  const [vaultName, setVaultName] = useState("");
  const [folder, setFolder] = useState("");
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  /**
   * Turn the input into a folder picker, and find out whether that worked.
   *
   * `webkitdirectory` is not in React's prop types, so it was being spread in
   * as a string attribute and trusted. Set as a property it is unambiguous —
   * and reading it back says whether this browser does directory picking at
   * all, which is the difference between "nothing happened" and "your browser
   * cannot do this", two things that looked the same.
   */
  const [canPickFolders, setCanPickFolders] = useState(true);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const supported = "webkitdirectory" in el;
    setCanPickFolders(supported);
    if (supported) {
      (el as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
      el.setAttribute("webkitdirectory", "");
      el.setAttribute("directory", "");
    }
  }, []);

  /** Top-level folders that actually contain notes — the only ones worth offering. */
  const folders = useMemo(() => {
    const seen = new Map<string, number>();
    for (const p of picked.keys()) {
      if (!p.endsWith(".md")) continue;
      const top = p.includes("/") ? p.slice(0, p.indexOf("/")) : "";
      seen.set(top, (seen.get(top) ?? 0) + 1);
    }
    return [...seen].sort((a, b) => b[1] - a[1]);
  }, [picked]);

  const choose = (files: FileList | null) => {
    // Cancelling is not an error; getting files and keeping none of them is.
    if (!files) return;
    if (!files.length) {
      setError("That folder came back empty. If it lives in iCloud Drive, open it in Finder once so the files are downloaded, then try again.");
      return;
    }
    const map: Picked = new Map();
    for (const f of Array.from(files)) {
      const rel = relPath(f);
      if (rel && !rel.split("/").some((s) => s.startsWith("."))) map.set(rel, f);
    }
    const first = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
    if (!map.size) {
      setError(
        first
          ? "Nothing in that folder could be read — every file was hidden or in a dot-folder."
          : "That looks like a single file rather than a folder. Choose the vault's folder itself.",
      );
      return;
    }
    setVaultName(first.split("/")[0] ?? "");
    setPicked(map);
    setPlan(null);
    setDone(null);
    setError(null);
    setFolder("");
  };

  const scan = async () => {
    setBusy(true);
    setError(null);
    setProgress("Reading notes…");
    try {
      const index = buildIndex([...picked.keys()]);
      const prefix = folder ? `${folder}/` : "";
      const inFolder = (p: string) => (folder ? p.startsWith(prefix) : !p.includes("/"));
      const mds = [...picked.keys()].filter((p) => p.endsWith(".md") && inFolder(p)).sort();
      const parsed = [];
      for (const p of mds) parsed.push(parseNote(p, await picked.get(p)!.text(), index));
      setPlan(planImport(parsed, { inFolder }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "couldn't read that folder");
    } finally {
      setBusy(false);
      setProgress("");
    }
  };

  /**
   * Write it.
   *
   * Three steps, in this order because each needs the one before: the notes are
   * created (which is what mints their ids and resolves every link between
   * them), then the files are uploaded against the note that owns them, and
   * only then can `attach:` become a real URL — so the notes carrying one are
   * written a second time.
   */
  const run = async () => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      // Every id first, before a single note is written. Notes link to each
      // other, so a link can only be written once both ends have an id — and
      // once they all do, the import can be cut into as many requests as the
      // body limit needs without a link crossing a batch and landing on
      // nothing. The server takes these as given; `POST /blocks` has accepted a
      // caller-supplied id since it was written.
      const ids: Record<string, string> = {};
      for (const n of plan.notes) ids[n.key] = crypto.randomUUID();

      // The run's handle, made before anything joins it. Best-effort: a marker
      // that cannot be created is not a reason to refuse an import, it just
      // means this one has no undo.
      const when = new Date().toLocaleString();
      const run = await api
        .post<{ id: string }>("/collections", {
          kind: "list",
          title: `Obsidian import — ${folder || "vault root"} — ${when}`,
          description: `${RUN_MARK}: ${folder || "vault root"}, ${when}. Archiving these puts the whole import back.`,
        })
        .catch(() => null);

      // Batched by bytes, because a vault is several megabytes and Fastify
      // takes one. The count cap is the server's, and this stays under it.
      const pending = plan.notes.map((n) => ({ id: ids[n.key]!, content: resolveLinks(n.body, ids) }));
      let createdTotal = 0;
      let taggedTotal = 0;
      const failures: { id: string; error: string }[] = [];
      for (let i = 0; i < pending.length; ) {
        const batch: typeof pending = [];
        let bytes = 0;
        while (i < pending.length && batch.length < 50 && bytes < 400_000) {
          bytes += pending[i]!.content.length;
          batch.push(pending[i]!);
          i++;
        }
        setProgress(`Creating notes ${i} of ${pending.length}…`);
        const res = await api.post<{ created: number; tagged: number; failed: { id: string; error: string }[] }>(
          "/import/obsidian",
          { notes: batch, ...(run ? { collectionId: run.id } : {}) },
        );
        createdTotal += res.created;
        taggedTotal += res.tagged;
        failures.push(...res.failed);
      }

      // Upload once per file, to whichever note owns its bytes, and remember
      // the URL every body will point at.
      const urls = new Map<string, string>();
      let n = 0;
      for (const f of plan.files) {
        setProgress(`Uploading ${++n} of ${plan.files.length}: ${f.path.split("/").pop()}`);
        const file = picked.get(f.path);
        const host = ids[f.host];
        if (!file || !host) continue;
        const form = new FormData();
        form.append("file", file, file.name);
        const up = await fetch(`${apiBase}/blocks/${host}/attachments`, {
          method: "POST",
          credentials: "include",
          headers: { "x-client-id": CLIENT_ID },
          body: form,
        });
        if (!up.ok) continue;
        const saved = (await up.json()) as { id: string }[];
        if (saved[0]) urls.set(f.path, `${apiBase}/attachments/${saved[0].id}`);
      }

      // Only now can a marker become a link, so the notes carrying one are
      // written a second time. A file that failed to upload leaves the words
      // that introduced it rather than a link to nothing.
      const needsUrls = plan.notes.filter((p) => p.body.includes("](attach:"));
      let m = 0;
      for (const p of needsUrls) {
        setProgress(`Linking files ${++m} of ${needsUrls.length}…`);
        const id = ids[p.key];
        if (!id) continue;
        const body = resolveLinks(p.body, ids).replace(
          /(!?)\[([^\]]*)\]\(attach:([^)]+)\)/g,
          (_w, bang: string, label: string, path: string) => {
            const url = urls.get(path);
            return url ? `${bang}[${label}](${url})` : label;
          },
        );
        const current = await api.get<{ version: number }>(`/blocks/${id}`).catch(() => null);
        if (!current) continue;
        await api.patch(`/blocks/${id}`, { version: current.version, content: body }).catch(() => {});
      }

      // What went wrong, not just how often. The first run of this reported
      // "307 failed" and nothing else — the reason was sitting in `failures`
      // the whole time, thrown away one line before it could be read.
      if (failures.length) {
        setError(`${failures.length} note${failures.length === 1 ? "" : "s"} were refused. The first said: ${failures[0]!.error}`);
      }
      setDone(
        `Imported ${createdTotal} of ${plan.notes.length} notes` +
          (plan.files.length ? `, ${urls.size} of ${plan.files.length} files` : "") +
          (taggedTotal ? `, ${taggedTotal} of them tagged` : "") +
          (failures.length ? ` — ${failures.length} failed.` : "."),
      );
      setPlan(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "import failed");
    } finally {
      setBusy(false);
      setProgress("");
    }
  };

  return (
    <div className="card">
      <div className="panel-h" style={{ marginTop: 0 }}>Import from Obsidian</div>
      <p className="hint" style={{ marginTop: 0 }}>
        Notes arrive as text, with the file name as the first line.{" "}
        <code>[[wikilinks]]</code> become Hermes links (keeping their labels),{" "}
        <code>#tags</code> are absorbed, and embedded images and files come across as attachments,
        shown where they appear. Pick the <strong>whole vault</strong> — a note often embeds a file
        from another folder, and a bare <code>[[name]]</code> is resolved against every file there
        is. Then choose which folder becomes notes.
      </p>
      <p className="hint">
        Each run makes a list collection holding everything it created — that is the undo. Archiving
        a collection offers to archive its blocks with it, under <strong>Collections</strong>.
      </p>

      <div className="row" style={{ alignItems: "center", gap: 12 }}>
        <button className="ghost" onClick={() => input.current?.click()} disabled={busy}>
          <FolderOpen size={15} /> {picked.size ? "Choose a different vault" : "Choose vault folder…"}
        </button>
        {picked.size > 0 && (
          <span className="hint">
            {vaultName} — {picked.size.toLocaleString()} files
          </span>
        )}
        {!canPickFolders && (
          <span className="hint">This browser can’t choose a folder — try Chrome, Edge or Safari.</span>
        )}
        <input
          ref={input}
          type="file"
          multiple
          // Off-screen rather than `hidden`. A file input at `display: none`
          // cannot always be opened by a scripted click — the browser has
          // nothing to attach the picker to — and the failure is silent, which
          // is exactly what this looked like.
          style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
          onChange={(e) => choose(e.target.files)}
        />
      </div>

      {folders.length > 0 && (
        <div className="row" style={{ marginTop: 14, alignItems: "center", gap: 10 }}>
          <label className="hint" htmlFor="import-folder">Folder to import</label>
          <select
            id="import-folder"
            value={folder}
            onChange={(e) => { setFolder(e.target.value); setPlan(null); }}
            disabled={busy}
          >
            <option value="">— choose —</option>
            {folders.map(([f, n]) => (
              <option key={f} value={f}>
                {f || "(vault root)"} — {n} note{n === 1 ? "" : "s"}
              </option>
            ))}
          </select>
          <button className="ghost" onClick={() => void scan()} disabled={busy || !folders.length}>
            Scan
          </button>
        </div>
      )}

      {progress && <div className="hint" style={{ marginTop: 10 }}>{progress}</div>}
      {plan && <PlanReview plan={plan} busy={busy} onImport={() => void run()} />}
      {done && <div className="hint" style={{ marginTop: 10 }}>{done}</div>}
      {error && <div className="error" style={{ marginTop: 10 }}>{error}</div>}
    </div>
  );
}

/** `](import:key)` → `](block:id)`, the same swap the server makes on create. */
function resolveLinks(body: string, ids: Record<string, string>): string {
  return body.replace(/\[([^\]]*)\]\(import:([^)]+)\)/g, (_w, label: string, key: string) =>
    ids[key] ? `[${label}](block:${ids[key]})` : label,
  );
}

/**
 * Everything that is about to happen, before it happens.
 *
 * One confirmation for the batch — but the batch is shown note by note, because
 * a total is not something anybody can check. Seeing the tags on a note is what
 * tells you the tag list is right; seeing the excerpt is what tells you the
 * file split into notes the way you expected.
 */
function PlanReview({ plan, busy, onImport }: { plan: ImportPlan; busy: boolean; onImport: () => void }) {
  const real = plan.notes.filter((n) => n.kind === "note");
  const stubs = plan.notes.filter((n) => n.kind === "stub");
  const files = plan.notes.filter((n) => n.kind === "file");
  return (
    <div style={{ marginTop: 16 }}>
      <div className="row" style={{ gap: 18, flexWrap: "wrap", alignItems: "baseline" }}>
        <strong>{real.length} notes</strong>
        {stubs.length > 0 && <span>{stubs.length} stub notes</span>}
        {files.length > 0 && <span>{files.length} file notes</span>}
        <span>{plan.files.length} attachments</span>
        <span>{plan.tags.length} tags</span>
      </div>

      {plan.warnings.map((w) => (
        <p className="hint" key={w} style={{ marginTop: 8 }}>{w}</p>
      ))}

      <div className="import-preview">
        {plan.notes.map((n) => <NoteRow key={n.key} note={n} />)}
      </div>

      <div className="row" style={{ marginTop: 14, alignItems: "center", gap: 12 }}>
        <button className="primary" onClick={onImport} disabled={busy}>
          <Upload size={15} />
          {busy ? "Importing…" : `Import ${plan.notes.length} notes`}
        </button>
      </div>
    </div>
  );
}

function NoteRow({ note }: { note: PlannedNote }) {
  const links = [...note.body.matchAll(/\]\(import:([^)]+)\)/g)].length;
  const attached = [...new Set([...note.body.matchAll(/\]\(attach:([^)]+)\)/g)].map((m) => m[1]!))];
  return (
    <div className="import-note">
      <div className="import-note-h">
        <span className="import-note-title">{note.title}</span>
        {note.kind !== "note" && <span className="import-badge">{note.kind}</span>}
      </div>
      {note.excerpt && <div className="import-note-excerpt">{note.excerpt}</div>}
      <div className="import-note-meta">
        {links > 0 && <span>{links} link{links === 1 ? "" : "s"}</span>}
        {note.tags.length > 0 && (
          <span title={note.tags.join(", ")}>
            {note.tags.length} tag{note.tags.length === 1 ? "" : "s"}: {note.tags.slice(0, 6).join(", ")}
            {note.tags.length > 6 ? "…" : ""}
          </span>
        )}
        {attached.map((p) => (
          <span key={p} className="import-file">
            {IMG.test(p) ? "image" : "file"}: {p.split("/").pop()}
          </span>
        ))}
      </div>
    </div>
  );
}
