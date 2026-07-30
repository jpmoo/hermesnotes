import { X } from "lucide-react";
import { apiBase } from "../api.ts";
import { usePreferences } from "../lib/preferences.tsx";
import { BannerAddButton, type BannerValue } from "./Banner.tsx";

/** Settings card for the page-background feature (Settings page). */
export function BackgroundSettings() {
  const { prefs, setPref } = usePreferences();
  const useBanner = Boolean(prefs.bg_use_banner);
  const animate = Boolean(prefs.bg_animate);
  const scanlines = Boolean(prefs.bg_scanlines);
  const blur = Math.max(0, Math.min(40, Number(prefs.bg_blur) || 0));
  // Stored as opacity (1 = opaque); shown as transparency (0% = opaque).
  const imgTransp = Math.round((1 - (prefs.bg_opacity == null ? 1 : Number(prefs.bg_opacity))) * 100);
  const panelT = Math.max(0, Math.min(100, Number(prefs.panel_transparency) || 0));
  const panelBlur = panelT > 0 && prefs.panel_blur === true;
  const fallback = prefs.bg_fallback as BannerValue | null | undefined;

  const check = (key: string, checked: boolean, label: string, hint?: string) => (
    <label className="row bg-opt">
      <input type="checkbox" checked={checked} onChange={(e) => setPref(key, e.target.checked)} />
      <span>
        {label}
        {hint && <span className="hint bg-opt-hint"> — {hint}</span>}
      </span>
    </label>
  );

  return (
    <div className="card">
      <h2 className="chrome" style={{ margin: "0 0 4px", fontSize: 15 }}>
        Background image
      </h2>
      <p className="hint" style={{ marginBottom: 14 }}>
        Show an image behind the page content, in the gaps between blocks.
      </p>

      {check("bg_use_banner", useBanner, "Use the page's banner as the background", "on landing pages that have a banner; zoomed to fill")}
      {check("bg_animate", animate, "Animate the background", "drifts very slowly in shifting directions")}
      {check("bg_scanlines", scanlines, "Scanline overlay", "faint CRT-style horizontal lines")}

      <div className="field" style={{ marginTop: 10 }}>
        <span className="field-label">Blur — {blur}px</span>
        <input
          type="range"
          min={0}
          max={40}
          value={blur}
          onChange={(e) => setPref("bg_blur", Number(e.target.value))}
          style={{ width: "100%" }}
        />
      </div>

      <div className="field" style={{ marginTop: 10 }}>
        <span className="field-label">Image transparency — {imgTransp}%</span>
        <input
          type="range"
          min={0}
          max={100}
          value={imgTransp}
          onChange={(e) => setPref("bg_opacity", 1 - Number(e.target.value) / 100)}
          style={{ width: "100%" }}
        />
      </div>

      <div className="field" style={{ marginTop: 10 }}>
        <span className="field-label">Panel transparency — {panelT}%</span>
        <p className="hint" style={{ marginBottom: 6 }}>
          Let the background show through the left and right panels.
        </p>
        <input
          type="range"
          min={0}
          max={100}
          value={panelT}
          onChange={(e) => setPref("panel_transparency", Number(e.target.value))}
          style={{ width: "100%" }}
        />
        {/* Nothing shows through an opaque panel, so there'd be nothing to blur. */}
        <label className="row bg-opt" style={{ marginTop: 8 }}>
          <input
            type="checkbox"
            checked={panelBlur}
            disabled={panelT === 0}
            onChange={(e) => setPref("panel_blur", e.target.checked)}
          />
          <span className={panelT === 0 ? "hint" : undefined}>
            Blur behind panels
            <span className="hint bg-opt-hint">
              {panelT === 0
                ? " — needs some panel transparency first"
                : " — frosts whatever shows through, so panel text stays readable"}
            </span>
          </span>
        </label>
      </div>

      <div className="field" style={{ marginTop: 14 }}>
        <span className="field-label">Fallback image</span>
        <p className="hint" style={{ marginBottom: 8 }}>
          Used as the background on pages without a banner (PNG, JPG, GIF).
        </p>
        {fallback?.id ? (
          <div className="row" style={{ gap: 12 }}>
            <span
              className="bg-fallback-thumb"
              style={{ backgroundImage: `url(${apiBase}/banners/${fallback.id})` }}
            />
            <BannerAddButton onAdded={(v) => setPref("bg_fallback", v)} label="Replace" />
            <button className="ghost" onClick={() => setPref("bg_fallback", undefined)}>
              <X size={14} /> Remove
            </button>
          </div>
        ) : (
          <BannerAddButton onAdded={(v) => setPref("bg_fallback", v)} label="Upload background" />
        )}
      </div>
    </div>
  );
}
