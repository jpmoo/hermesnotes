import { Download, FileText, Paperclip, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, apiBase, type Attachment } from "../api.ts";
import { useIsMobile } from "../lib/useIsMobile.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

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
  const isMobile = useIsMobile();
  const inputRef = useRef<HTMLInputElement>(null);

  const load = () =>
    void api.get<Attachment[]>(`/blocks/${blockId}/attachments`).then(setFiles).catch(() => {});
  useEffect(load, [blockId]);

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
      </div>

      {files.length > 0 && (
        <ul className="attach-list">
          {files.map((f) => (
            <li key={f.id} className="attach-item">
              <FileText size={15} className="attach-icon" />
              <a
                className="attach-name"
                href={`${apiBase}/attachments/${f.id}`}
                target="_blank"
                rel="noreferrer"
                title={f.filename}
              >
                {f.filename}
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
              <button className="icon-btn attach-del" title="Remove" onClick={() => setConfirm(f)}>
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
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
