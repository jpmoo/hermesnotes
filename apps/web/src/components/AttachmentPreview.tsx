import { Download, Minus, Plus, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, apiBase, type Attachment } from "../api.ts";
import { usePanels } from "../lib/right-panel.tsx";
import { iconFor, SHOWABLE } from "./file-kinds.ts";

/** A note this file is on. */
interface Holder {
  attachmentId: string;
  id: string;
  typeId: string | null;
  title: string;
  archived: boolean;
}

const STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];

/**
 * A file, looked at rather than downloaded.
 *
 * Clicking an attachment used to fetch a URL whose `Content-Disposition` says
 * "save me", so looking at a scan meant downloading it, opening it in whatever
 * the operating system decided, and coming back. This shows it.
 *
 * Three kinds of file and three answers. An image the browser can draw gets a
 * zoomable surface. A PDF gets the browser's own viewer in a frame, which
 * already has zoom, search and paging — reimplementing that would be worse in
 * every way. Anything else gets its icon and its facts, which is honest: there
 * is nothing to show and pretending otherwise wastes somebody's time.
 *
 * And it says which notes hold the file, because once the same bytes can hang
 * off several notes that is a question somebody will have, and the useful form
 * of the answer is one you can click.
 */
export function AttachmentPreview({
  file,
  onClose,
}: {
  file: Attachment;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [holders, setHolders] = useState<Holder[] | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const { openBlock } = usePanels();

  const src = `${apiBase}/attachments/blob/${file.sha256}`;
  const showable = SHOWABLE.test(file.mime);
  const isPdf = file.mime === "application/pdf";

  useEffect(() => {
    void api
      .get<Holder[]>(`/attachments/blob/${file.sha256}/notes`)
      .then(setHolders)
      .catch(() => setHolders([]));
  }, [file.sha256]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      // The shortcuts anybody tries in a viewer without being told about them.
      if (e.key === "+" || e.key === "=") step(1);
      if (e.key === "-") step(-1);
      if (e.key === "0") setZoom(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const step = useCallback((by: number) => {
    setZoom((z) => {
      const at = STEPS.findIndex((s) => s >= z - 0.001);
      const next = STEPS[Math.min(STEPS.length - 1, Math.max(0, (at === -1 ? 0 : at) + by))];
      return next ?? z;
    });
  }, []);

  /*
   * Ctrl/⌘ + wheel zooms; a plain wheel scrolls the surface.
   *
   * The same split every map and every document viewer uses, and the reason
   * `passive: false` matters: without it the browser has already begun its own
   * page zoom by the time this runs and `preventDefault` is refused.
   */
  useEffect(() => {
    const el = surface.current;
    if (!el || !showable) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      step(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [showable, step]);

  const Icon = iconFor(file.mime, file.filename);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card preview-card"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="preview-head">
          <span className="preview-name" title={file.filename}>
            {file.filename}
          </span>
          {showable && (
            <span className="preview-zoom">
              <button className="icon-btn" title="Zoom out" onClick={() => step(-1)}>
                <Minus size={14} />
              </button>
              <span className="preview-pct">{Math.round(zoom * 100)}%</span>
              <button className="icon-btn" title="Zoom in" onClick={() => step(1)}>
                <Plus size={14} />
              </button>
              <button className="icon-btn" title="Actual size" onClick={() => setZoom(1)}>
                <RotateCcw size={13} />
              </button>
            </span>
          )}
          <a
            className="icon-btn"
            href={`${apiBase}/attachments/${file.id}`}
            download={file.filename}
            title="Download"
          >
            <Download size={15} />
          </a>
          <button className="icon-btn" title="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className={`preview-surface${showable ? " zoomable" : ""}`} ref={surface}>
          {showable ? (
            // Sized rather than transformed: a scaled element keeps its
            // original box, so the surface would not scroll and half a zoomed
            // picture would be unreachable.
            <img src={src} alt={file.filename} style={{ width: `${zoom * 100}%` }} />
          ) : isPdf ? (
            // The browser's own viewer, which has zoom, paging and search
            // already. Reimplementing those would be worse in every way.
            <iframe src={src} title={file.filename} />
          ) : (
            <div className="preview-none">
              <Icon size={44} />
              <p>Nothing to show for this kind of file.</p>
              <a className="ghost" href={`${apiBase}/attachments/${file.id}`} download={file.filename}>
                Download it
              </a>
            </div>
          )}
        </div>

        <div className="preview-holders">
          {holders === null ? (
            <span className="hint">Looking for where else this is…</span>
          ) : holders.length <= 1 ? (
            <span className="hint">Only on this note.</span>
          ) : (
            <>
              <span className="hint">On {holders.length} notes:</span>
              {holders.map((h) => (
                <button
                  key={h.attachmentId}
                  className={`ref-chip${h.archived ? " archived" : ""}`}
                  title={h.archived ? `${h.title} (archived)` : h.title}
                  onClick={() => {
                    openBlock(h.id);
                    onClose();
                  }}
                >
                  <span className="ref-chip-label">{h.title}</span>
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
