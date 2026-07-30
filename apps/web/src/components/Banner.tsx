import { ImagePlus, Move, Trash2, X, ZoomIn } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { api, apiBase } from "../api.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/**
 * Banner value: which uploaded image, and how it's framed. `zoom` scales the
 * cover-fit image; `x`/`y` are focal offsets in percent (0–100, 50 = centered).
 */
export interface BannerValue {
  id: string;
  zoom?: number;
  x?: number;
  y?: number;
}

/**
 * A reusable banner strip for any entity (block, collection, landing page).
 * Read-only unless `editable`: then it offers upload (PNG/JPG/GIF), drag to
 * reposition the focal point, a zoom slider, and remove. `onChange` persists
 * the framing; the caller decides where (block props, collection props, prefs).
 */
export function Banner({
  value,
  editable = false,
  onChange,
  height = 180,
  className,
}: {
  value: BannerValue | null | undefined;
  editable?: boolean;
  onChange?: (v: BannerValue | null) => void;
  height?: number;
  className?: string;
}) {
  const dragRef = useRef<{ sx: number; sy: number; x: number; y: number } | null>(null);

  // Empty state is no longer a block here — callers place <BannerAddButton>
  // on the title line instead. The strip renders only once a banner exists.
  if (!value) return null;

  const zoom = value.zoom ?? 1;
  const x = value.x ?? 50;
  const y = value.y ?? 50;

  const onPointerDown = (e: ReactPointerEvent) => {
    if (!editable) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { sx: e.clientX, sy: e.clientY, x, y };
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    // Drag right → reveal more of the left, i.e. lower object-position x.
    const nx = Math.min(100, Math.max(0, d.x - ((e.clientX - d.sx) / 4)));
    const ny = Math.min(100, Math.max(0, d.y - ((e.clientY - d.sy) / 4)));
    onChange?.({ ...value, x: Math.round(nx), y: Math.round(ny) });
  };
  const endDrag = () => {
    dragRef.current = null;
  };

  return (
    <div className={`banner${editable ? " editable" : ""}${className ? ` ${className}` : ""}`} style={{ height }}>
      <div
        className="banner-img"
        style={{
          backgroundImage: `url(${apiBase}/banners/${value.id})`,
          backgroundSize: `${zoom * 100}% auto`,
          backgroundPosition: `${x}% ${y}%`,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
      {editable && (
        <div className="banner-tools" onPointerDown={(e) => e.stopPropagation()}>
          <span className="banner-hint" title="Drag the image to reposition">
            <Move size={13} />
          </span>
          <span className="banner-zoom" title="Zoom">
            <ZoomIn size={13} />
            <input
              type="range"
              min={100}
              max={300}
              value={Math.round(zoom * 100)}
              onChange={(e) => onChange?.({ ...value, zoom: Number(e.target.value) / 100 })}
            />
          </span>
          <button className="icon-btn banner-remove" title="Remove banner" onClick={() => onChange?.(null)}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}


/** Upload an image and return a fresh centered/1x banner value. */
export async function uploadBanner(file: File): Promise<BannerValue> {
  const form = new FormData();
  form.append("file", file);
  const { id } = await api.upload<{ id: string }>("/banners", form);
  return { id, zoom: 1, x: 50, y: 50 };
}

/** One of the account's uploaded banners, as listed for the gallery. */
interface BannerInfo {
  id: string;
  mime: string;
  size: number;
  createdAt: string;
  /** Everywhere it's currently used — blocks, collections, pages, background. */
  usedBy: string[];
}

/**
 * Banner chooser: the images already uploaded to this account, so one can be
 * reused anywhere without uploading it a second time, plus a way to add a new
 * one. Images are shared account-wide — picking one here never alters another
 * page that already uses it, since each place stores its own framing.
 */
function BannerPicker({
  onPick,
  onClose,
}: {
  onPick: (v: BannerValue) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<BannerInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<BannerInfo | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Held in a ref so the effect below doesn't re-run (and refetch) whenever the
  // caller hands us a fresh closure.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const reload = () =>
    api
      .get<BannerInfo[]>("/banners")
      .then(setItems)
      .catch(() => setItems([]));

  useEffect(() => {
    void reload();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const upload = async (file: File) => {
    setBusy(true);
    setErr(null);
    try {
      onPick(await uploadBanner(file));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed");
      setBusy(false);
    }
  };

  // Portalled for the same reason as ConfirmDialog: callers often sit inside the
  // auto-hiding right panel, which would swallow an in-place modal.
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card banner-picker"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">Choose a banner</h2>
        {items == null ? (
          <div className="hint">Loading…</div>
        ) : items.length === 0 ? (
          <div className="hint">No banners uploaded yet — add your first below.</div>
        ) : (
          <div className="banner-gallery">
            {items.map((b) => (
              <div key={b.id} className={`banner-cell${b.usedBy.length ? " in-use" : ""}`}>
                <button
                  className="banner-thumb"
                  /* Listing where it's used matters before deleting one: the same
                     image can sit on several notes and pages at once. */
                  title={
                    b.usedBy.length
                      ? `In use on:\n${b.usedBy.map((u) => `• ${u}`).join("\n")}`
                      : "Not used anywhere yet"
                  }
                  onClick={() => onPick({ id: b.id, zoom: 1, x: 50, y: 50 })}
                >
                  <img src={`${apiBase}/banners/${b.id}`} alt="" loading="lazy" />
                </button>
                {b.usedBy.length > 0 && (
                  <span className="banner-used-badge" aria-hidden>
                    {b.usedBy.length}
                  </span>
                )}
                <button
                  className="icon-btn banner-del"
                  title="Delete this image"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPendingDelete(b);
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
        {err && <div className="error">{err}</div>}
        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy} onClick={() => fileRef.current?.click()}>
            <ImagePlus size={14} />
            {busy ? "Uploading…" : "Upload new image"}
          </button>
        </div>
        <ConfirmDialog
          open={pendingDelete !== null}
          title="Delete this image?"
          message={
            pendingDelete?.usedBy.length
              ? `It's in use on ${pendingDelete.usedBy.length} place(s) — ${pendingDelete.usedBy.join(", ")} — and will be removed from each. This can't be undone.`
              : "It isn't used anywhere. This can't be undone."
          }
          confirmLabel="Delete"
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            const target = pendingDelete;
            setPendingDelete(null);
            if (!target) return;
            void api
              .del(`/banners/${target.id}`)
              .then(reload)
              .catch((e) => setErr(e instanceof Error ? e.message : "Couldn't delete that image"));
          }}
        />
        <ConfirmDialog
          open={pendingDelete !== null}
          title="Delete this image?"
          message={
            pendingDelete?.usedBy.length
              ? `It's in use on ${pendingDelete.usedBy.length} place(s) — ${pendingDelete.usedBy.join(", ")} — and will be removed from each. This can't be undone.`
              : "It isn't used anywhere. This can't be undone."
          }
          confirmLabel="Delete"
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            const target = pendingDelete;
            setPendingDelete(null);
            if (!target) return;
            void api
              .del(`/banners/${target.id}`)
              .then(reload)
              .catch((e) => setErr(e instanceof Error ? e.message : "Couldn't delete that image"));
          }}
        />
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/gif"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void upload(file);
          }}
        />
      </div>
    </div>,
    document.body,
  );
}

/**
 * The "Add banner" affordance — placed on a title line by the caller. Opens the
 * gallery of already-uploaded banners first; uploading is one click from there.
 */
export function BannerAddButton({
  onAdded,
  className,
  label = "Add banner",
}: {
  onAdded: (v: BannerValue) => void;
  className?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className={`ghost banner-add${className ? ` ${className}` : ""}`}
        title="Choose an existing banner, or upload a new one"
        onClick={() => setOpen(true)}
      >
        <ImagePlus size={14} />
        {label}
      </button>
      {open && (
        <BannerPicker
          onPick={(v) => {
            setOpen(false);
            onAdded(v);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
