import {
  Download,
  FolderInput,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Paperclip,
  Presentation,
  Trash2,
  Upload,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, apiBase, type Attachment, type BlockType } from "../api.ts";
import { AttachmentPlaceModal } from "./AttachmentPlaceModal.tsx";
import { FileLibraryModal } from "./FileLibraryModal.tsx";
import { useIsMobile } from "../lib/useIsMobile.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/**
 * The icon for a file nobody can show a picture of.
 *
 * By media type first and by extension only as a fallback, because the media
 * type is what the file said about itself and an extension is what somebody
 * typed. Neither is trustworthy alone: a `.md` uploaded from a phone often
 * arrives as `application/octet-stream`, which would put a blank page beside
 * every note somebody moved across.
 */
function iconFor(mime: string, filename: string) {
  const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  const is = (...xs: string[]) => xs.some((x) => mime.startsWith(x));
  if (is("audio/")) return FileAudio;
  if (is("video/")) return FileVideo;
  if (mime === "application/pdf" || ext === "pdf") return FileText;
  if (is("text/csv") || /^(csv|tsv|xls|xlsx|ods|numbers)$/.test(ext)) return FileSpreadsheet;
  if (/^(ppt|pptx|odp|key)$/.test(ext)) return Presentation;
  if (/^(zip|tar|gz|tgz|bz2|xz|7z|rar)$/.test(ext)) return FileArchive;
  if (
    is("application/json", "application/xml", "text/html", "text/css", "text/javascript") ||
    /^(json|xml|ya?ml|toml|js|ts|tsx|jsx|py|rb|go|rs|swift|kt|java|c|h|cpp|sh)$/.test(ext)
  ) {
    return FileCode;
  }
  if (is("text/") || /^(md|markdown|txt|rtf|doc|docx|odt)$/.test(ext)) return FileText;
  return FileIcon;
}

/**
 * Whether the browser will draw this as a picture.
 *
 * Named formats rather than the whole of `image/*`: a TIFF or a HEIC is an
 * image the browser cannot render, and an `<img>` pointed at one shows a broken
 * icon — which reads as a damaged upload rather than as a format nothing here
 * can display. Those fall through to the icon, which is honest and looks
 * deliberate.
 */
const SHOWABLE = /^image\/(png|jpeg|gif|webp|avif|svg\+xml|bmp)$/;

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Upload area for a block's attachments. Files are stored server-side (in the
 * database, alongside the block). Supports multiple files, download, and
 * remove-with-confirmation (which deletes the file from the server).
 */
export function AttachmentsField({ blockId }: { blockId: string }) {
  const [files, setFiles] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [confirm, setConfirm] = useState<Attachment | null>(null);
  /** Which row's move menu is open, by attachment id. */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** The picker, once somebody has said move or copy. */
  const [placing, setPlacing] = useState<{ file: Attachment; mode: "move" | "copy" } | null>(null);
  const [types, setTypes] = useState<BlockType[]>([]);
  /**
   * Today's scratchpad, so this block can tell whether it *is* one.
   *
   * Offering "send this to today's note" while looking at today's note is an
   * offer to move a thing to where it already is. A failure to find out leaves
   * this null, which shows the options — the safe direction, since a redundant
   * menu item is a smaller injury than a missing one, and the server answers
   * `unchanged` for that case anyway.
   */
  const [todayId, setTodayId] = useState<string | null>(null);
  /** The library, for attaching a file that is already here. */
  const [library, setLibrary] = useState(false);
  const isMobile = useIsMobile();
  const inputRef = useRef<HTMLInputElement>(null);

  const load = () =>
    void api.get<Attachment[]>(`/blocks/${blockId}/attachments`).then(setFiles).catch(() => {});
  useEffect(load, [blockId]);

  useEffect(() => {
    void api.get<BlockType[]>("/block-types").then(setTypes).catch(() => setTypes([]));
    const today = new Date().toLocaleDateString("en-CA");
    void api
      .get<{ id: string }>(`/today/${today}/note`)
      .then((n) => setTodayId(n.id))
      .catch(() => setTodayId(null));
  }, []);

  // A click anywhere else closes the menu, which is what a menu does and what
  // somebody who opened one by accident tries first.
  useEffect(() => {
    if (!menuFor) return;
    const away = () => setMenuFor(null);
    window.addEventListener("click", away);
    return () => window.removeEventListener("click", away);
  }, [menuFor]);

  /** Straight to today's page — no picker, because there is nothing to pick. */
  const toToday = async (file: Attachment, mode: "move" | "copy") => {
    setMenuFor(null);
    if (!todayId) return;
    await api.post(`/attachments/${file.id}/place`, { blockId: todayId, mode }).catch(() => {});
    load();
  };

  const uploadFiles = async (list: FileList | File[]) => {
    const arr = [...list];
    if (arr.length === 0) return;
    setBusy(true);
    try {
      const form = new FormData();
      for (const f of arr) form.append("file", f);
      const saved = await api.upload<Attachment[]>(`/blocks/${blockId}/attachments`, form);
      setFiles((prev) => [...prev, ...saved]);
    } catch {
      /* surfaced by the empty result */
    } finally {
      setBusy(false);
    }
  };

  const remove = async (att: Attachment) => {
    setConfirm(null);
    setFiles((prev) => prev.filter((f) => f.id !== att.id));
    await api.del(`/attachments/${att.id}`).catch(() => load());
  };

  return (
    <div className="attach-field">
      <div
        className={`attach-drop${dragOver ? " over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void uploadFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
      >
        <Upload size={16} />
        <span>
          {busy
            ? "Uploading…"
            : isMobile
              ? "Add files and images from your device"
              : "Drop files or click to upload"}
        </span>
      </div>

      {/*
        Outside the drop zone, and it has to be.

        The input used to live inside the div whose `onClick` clicks it. A
        programmatic `.click()` dispatches a real click that bubbles — back into
        the same handler, which clicks it again. The file dialog opened over and
        over from one press, and because the openings queue up they surface while
        somebody is pressing something else entirely, so the blame lands on
        whatever button they touched next.

        A sibling cannot re-enter the handler, which is a fix by construction
        rather than by remembering to stop propagation in the right place.
      */}
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void uploadFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {/* Uploading is not the only way to attach a file, now that the same
          bytes can be pointed at from anywhere. Beside the drop zone rather
          than inside it, so dropping a file still means what it always did. */}
      <button
        className="attach-existing"
        onClick={(e) => {
          e.stopPropagation();
          setLibrary(true);
        }}
      >
        or attach a file you already have
      </button>

      {files.length > 0 && (
        <ul className="attach-list">
          {files.map((f) => (
            <li key={f.id} className="attach-item">
              {/* The file itself, where the browser can draw one.
                  A list of file names tells you what you attached; a row of
                  thumbnails tells you which one you want, which is the question
                  anybody actually has in front of five screenshots. Everything
                  else gets the icon for its kind — deliberate, rather than the
                  broken-image mark an <img> leaves on a format it cannot
                  render. */}
              <a
                className="attach-thumb"
                href={`${apiBase}/attachments/${f.id}`}
                target="_blank"
                rel="noreferrer"
                tabIndex={-1}
                aria-hidden="true"
              >
                {SHOWABLE.test(f.mime) ? (
                  <img src={`${apiBase}/attachments/${f.id}`} alt="" loading="lazy" />
                ) : (
                  (() => {
                    const Icon = iconFor(f.mime, f.filename);
                    return <Icon size={18} />;
                  })()
                )}
              </a>
              {/* A chip, not a link. The name is a thing you can pick up and
                  open — the same shape a mention has — and the underlined blue
                  it used to be read as a web address rather than as this
                  block's own file. */}
              <a
                className="attach-name"
                href={`${apiBase}/attachments/${f.id}`}
                target="_blank"
                rel="noreferrer"
                title={f.filename}
              >
                {/* No icon in the chip: the thumbnail beside it already says
                    what kind of file this is, and saying it twice on one row
                    is clutter rather than emphasis. */}
                <span className="attach-filename">{f.filename}</span>
              </a>
              <span className="attach-size">{humanSize(f.size)}</span>
              <a
                className="icon-btn"
                href={`${apiBase}/attachments/${f.id}`}
                download={f.filename}
                title="Download"
              >
                <Download size={14} />
              </a>
              <span className="attach-move">
                <button
                  className="icon-btn"
                  title="Move or copy this file"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuFor((open) => (open === f.id ? null : f.id));
                  }}
                >
                  <FolderInput size={14} />
                </button>
                {menuFor === f.id && (
                  <div className="menu" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="menu-item"
                      onClick={() => {
                        setMenuFor(null);
                        setPlacing({ file: f, mode: "move" });
                      }}
                    >
                      Move to a different note…
                    </button>
                    <button
                      className="menu-item"
                      onClick={() => {
                        setMenuFor(null);
                        setPlacing({ file: f, mode: "copy" });
                      }}
                    >
                      Copy to a different note…
                    </button>
                    {todayId !== blockId && (
                      <>
                        <button className="menu-item" onClick={() => void toToday(f, "move")}>
                          Move to today's scratchpad
                        </button>
                        <button className="menu-item" onClick={() => void toToday(f, "copy")}>
                          Copy to today's scratchpad
                        </button>
                      </>
                    )}
                  </div>
                )}
              </span>
              <button className="icon-btn attach-del" title="Remove" onClick={() => setConfirm(f)}>
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {library && (
        <FileLibraryModal blockId={blockId} onClose={() => setLibrary(false)} onAttached={load} />
      )}

      {placing && (
        <AttachmentPlaceModal
          attachment={placing.file}
          mode={placing.mode}
          types={types}
          onClose={() => setPlacing(null)}
          onDone={load}
        />
      )}

      <ConfirmDialog
        open={confirm !== null}
        title="Delete this file?"
        message={
          confirm
            ? `“${confirm.filename}” will be permanently removed from the server. This can't be undone.`
            : ""
        }
        confirmLabel="Delete"
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm && void remove(confirm)}
      />
    </div>
  );
}

/**
 * Compact attachments affordance for masonry cards: a paperclip shown only when
 * the block has files. Clicking opens a modal with the full add/delete/download
 * field.
 */
export function AttachmentsChip({ blockId }: { blockId: string }) {
  const [count, setCount] = useState<number | null>(null);
  const [open, setOpen] = useState(false);

  const load = () =>
    void api
      .get<Attachment[]>(`/blocks/${blockId}/attachments`)
      .then((a) => setCount(a.length))
      .catch(() => setCount(0));
  useEffect(load, [blockId]);

  if (count === null || count === 0) return null;

  const close = () => {
    setOpen(false);
    load();
  };

  return (
    <>
      <button
        className="attach-chip"
        title={`${count} attachment${count === 1 ? "" : "s"}`}
        onClick={() => setOpen(true)}
      >
        <Paperclip size={13} />
        <span>{count}</span>
      </button>
      {open &&
        createPortal(
          <div className="modal-backdrop" onClick={close}>
            <div
              className="modal-card"
              style={{ maxWidth: 480 }}
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="modal-title">Attachments</h2>
              <AttachmentsField blockId={blockId} />
              <div className="type-actions">
                <button className="ghost" onClick={close}>
                  Done
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
