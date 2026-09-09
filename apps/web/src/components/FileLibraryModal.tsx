import { Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, apiBase, type Attachment } from "../api.ts";
import { SHOWABLE } from "./file-kinds.ts";

/** One distinct file this account holds, however many notes point at it. */
export interface LibraryFile {
  sha256: string;
  filename: string;
  mime: string;
  size: number;
  createdAt: string;
  /** How many notes point at it. */
  uses: number;
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function when(iso: string): string {
  const d = new Date(iso);
  const days = (Date.now() - d.getTime()) / 86_400_000;
  if (days < 1) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "short" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}


/**
 * Every file already here, to attach without uploading again.
 *
 * Files are stored once under their own digest, so this lists *files* rather
 * than attachments — the same PDF on four notes appears once, with a count. A
 * picker that showed it four times would make choosing between four identical
 * rows the person's problem.
 *
 * Thumbnails come from the blob route, which is content-addressed and therefore
 * immutably cacheable: the same picture on this screen twice is fetched once,
 * and looking through a library of them a second time costs nothing.
 */
export function FileLibraryModal({
  blockId,
  onClose,
  onAttached,
}: {
  blockId: string;
  onClose: () => void;
  onAttached: () => void;
}) {
  const [files, setFiles] = useState<LibraryFile[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void api
      .get<LibraryFile[]>("/attachments/library")
      .then(setFiles)
      .catch(() => setFiles([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? files.filter((f) => f.filename.toLowerCase().includes(needle)) : files;
  }, [files, q]);

  const attach = async (file: LibraryFile) => {
    setBusy(file.sha256);
    try {
      await api.post(`/blocks/${blockId}/attachments/existing`, { sha256: file.sha256 });
      onAttached();
      onClose();
    } finally {
      setBusy(null);
    }
  };

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy("upload");
    try {
      const form = new FormData();
      for (const f of list) form.append("file", f);
      await api.upload<Attachment[]>(`/blocks/${blockId}/attachments`, form);
      onAttached();
      onClose();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card file-library"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="file-library-head">
          <h2 className="modal-title" style={{ margin: 0 }}>
            Attach a file
          </h2>
          <button className="primary" disabled={busy !== null} onClick={() => inputRef.current?.click()}>
            <Upload size={14} /> Upload new attachment
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void upload(e.target.files);
              e.target.value = "";
            }}
          />
        </div>

        <input
          type="text"
          placeholder="Search files you've already uploaded…"
          autoComplete="off"
          value={q}
          autoFocus
          onChange={(e) => setQ(e.target.value)}
        />

        {loading ? (
          <p className="hint">Reading your files…</p>
        ) : files.length === 0 ? (
          <p className="hint">
            Nothing uploaded yet. Upload one and it will be here next time — attaching it elsewhere
            after that costs nothing.
          </p>
        ) : shown.length === 0 ? (
          <p className="hint">No file matches “{q.trim()}”.</p>
        ) : (
          <ul className="file-grid">
            {shown.map((f) => (
              <li key={f.sha256}>
                <button
                  className="file-tile"
                  disabled={busy !== null}
                  title={`${f.filename} — ${human(f.size)}`}
                  onClick={() => void attach(f)}
                >
                  <span className="file-thumb">
                    {SHOWABLE.test(f.mime) ? (
                      <img src={`${apiBase}/attachments/blob/${f.sha256}`} alt="" loading="lazy" />
                    ) : (
                      <span className="file-ext">
                        {(f.filename.split(".").pop() ?? "file").slice(0, 4).toUpperCase()}
                      </span>
                    )}
                  </span>
                  <span className="file-name">{f.filename}</span>
                  <span className="file-meta">
                    {human(f.size)} · {when(f.createdAt)}
                    {/* Only when it is on more than one note: "1 note" is noise
                        on every tile, and the number only matters when it is
                        more than one. */}
                    {f.uses > 1 ? ` · on ${f.uses} notes` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
