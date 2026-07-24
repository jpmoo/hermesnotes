import { ImagePlus, Move, X, ZoomIn } from "lucide-react";
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { api, apiBase } from "../api.ts";

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

/** The "Add banner" affordance — placed on a title line by the caller. */
export function BannerAddButton({
  onAdded,
  className,
  label = "Add banner",
}: {
  onAdded: (v: BannerValue) => void;
  className?: string;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          setBusy(true);
          try {
            onAdded(await uploadBanner(file));
          } finally {
            setBusy(false);
          }
        }}
      />
      <button
        className={`ghost banner-add${className ? ` ${className}` : ""}`}
        disabled={busy}
        title="Add a banner image (PNG, JPG, GIF)"
        onClick={() => fileRef.current?.click()}
      >
        <ImagePlus size={14} />
        {busy ? "Uploading…" : label}
      </button>
    </>
  );
}
