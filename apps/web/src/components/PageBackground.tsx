import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { apiBase } from "../api.ts";
import type { BannerValue } from "./Banner.tsx";
import { usePreferences } from "../lib/preferences.tsx";
import { useRouteBanner } from "../lib/route-banner.tsx";

/** Which landing-page banner key backs a given route (null = not a landing). */
function bannerKeyForPath(path: string): string | null {
  if (path.startsWith("/today")) return "today";
  if (path.startsWith("/favorites")) return "favorites";
  if (path.startsWith("/blocks")) return "blocks";
  if (path === "/collections") return "collections";
  if (path.startsWith("/types")) return "types";
  if (path.startsWith("/review")) return "review";
  if (path.startsWith("/archive")) return "archive";
  return null;
}

/**
 * A full-viewport background image layer behind the content. Driven by
 * preferences: use the current landing page's banner (bg_use_banner), fall back
 * to an uploaded image (bg_fallback), optionally drift slowly (bg_animate) and
 * carry a scanline overlay (bg_scanlines). Renders nothing when no image
 * applies; the shell makes the main surface transparent so it shows through.
 */
export function PageBackground() {
  const { prefs, banner } = usePreferences();
  const { pathname } = useLocation();

  const routeBanner = useRouteBanner() as BannerValue | null;
  const isEntity =
    pathname.startsWith("/block/") ||
    (pathname.startsWith("/collections/") && pathname !== "/collections");
  const key = bannerKeyForPath(pathname);
  const pageBanner = isEntity ? routeBanner : key ? (banner(key) as BannerValue | null) : null;
  const fallback = prefs.bg_fallback as BannerValue | null | undefined;

  const active = (prefs.bg_use_banner ? pageBanner : null) ?? fallback ?? null;

  // Sample the image's average color and derive a readable, same-hue title
  // color (light title on a dark image, dark on a light one) — set as CSS vars
  // the page title/sub/icon pick up, so text stays legible and complementary.
  useEffect(() => {
    const root = document.documentElement;
    if (!active?.id) {
      root.style.removeProperty("--bg-title");
      root.style.removeProperty("--bg-title-shadow");
      return;
    }
    let alive = true;
    const img = new Image();
    img.src = `${apiBase}/banners/${active.id}`;
    img.onload = () => {
      if (!alive) return;
      try {
        const c = document.createElement("canvas");
        c.width = 24;
        c.height = 24;
        const ctx = c.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, 24, 24);
        const { data } = ctx.getImageData(0, 0, 24, 24);
        let r = 0,
          g = 0,
          b = 0;
        const n = data.length / 4;
        for (let i = 0; i < data.length; i += 4) {
          r += data[i]!;
          g += data[i + 1]!;
          b += data[i + 2]!;
        }
        r /= n;
        g /= n;
        b /= n;
        const [h, sat] = rgbToHs(r, g, b);
        const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        const dark = lum < 0.5;
        const s = Math.min(dark ? 0.6 : 0.7, Math.max(0.25, sat));
        const title = `hsl(${Math.round(h)}, ${Math.round(s * 100)}%, ${dark ? 92 : 16}%)`;
        const shadow = dark ? "rgba(0,0,0,0.55)" : "rgba(255,255,255,0.65)";
        root.style.setProperty("--bg-title", title);
        root.style.setProperty("--bg-title-shadow", shadow);
      } catch {
        /* tainted canvas or read failure — leave defaults */
      }
    };
    return () => {
      alive = false;
    };
  }, [active?.id]);

  if (!active?.id) return null;

  const cls =
    "page-bg" +
    (prefs.bg_animate ? " anim" : "") +
    (prefs.bg_scanlines ? " scan" : "");
  const blur = Math.max(0, Math.min(40, Number(prefs.bg_blur) || 0));
  // Image opacity (1 = opaque). Absent = fully opaque, preserving prior behavior.
  const opacity = prefs.bg_opacity == null ? 1 : Math.max(0, Math.min(1, Number(prefs.bg_opacity)));
  return (
    <div className={cls} aria-hidden>
      <div
        className="page-bg-img"
        style={{
          backgroundImage: `url(${apiBase}/banners/${active.id})`,
          opacity,
          ...(blur ? { filter: `blur(${blur}px)` } : {}),
        }}
      />
    </div>
  );
}

/** Whether a background image is currently active (to toggle transparency). */
export function useHasPageBackground(): boolean {
  const { prefs, banner } = usePreferences();
  const { pathname } = useLocation();
  const routeBanner = useRouteBanner() as BannerValue | null;
  const isEntity =
    pathname.startsWith("/block/") ||
    (pathname.startsWith("/collections/") && pathname !== "/collections");
  const key = bannerKeyForPath(pathname);
  const pageBanner = isEntity ? routeBanner : key ? (banner(key) as BannerValue | null) : null;
  const fallback = prefs.bg_fallback as BannerValue | null | undefined;
  return Boolean((prefs.bg_use_banner && pageBanner?.id) || fallback?.id);
}

/** RGB (0–255) → [hue 0–360, saturation 0–1] of the HSL model. */
function rgbToHs(r: number, g: number, b: number): [number, number] {
  const rn = r / 255,
    gn = g / 255,
    bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s];
}
