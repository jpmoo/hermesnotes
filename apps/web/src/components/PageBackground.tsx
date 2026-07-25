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
  if (!active?.id) return null;

  const cls =
    "page-bg" +
    (prefs.bg_animate ? " anim" : "") +
    (prefs.bg_scanlines ? " scan" : "");
  return (
    <div className={cls} aria-hidden>
      <div
        className="page-bg-img"
        style={{ backgroundImage: `url(${apiBase}/banners/${active.id})` }}
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
