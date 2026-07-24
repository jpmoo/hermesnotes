import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "../api.ts";

export interface NavColors {
  bg?: string;
  text?: string;
  icon?: string;
}

interface PreferencesApi {
  prefs: Record<string, unknown>;
  setPref: (key: string, value: unknown) => void;
  colors: (key: string) => NavColors;
  /** Starred blocks/collections (ordered by when they were starred). */
  favorites: string[];
  isFavorite: (id: string) => boolean;
  toggleFavorite: (id: string) => void;
  /** Banner framing for a landing page (key like "blocks"/"today"). */
  banner: (key: string) => unknown;
  setBanner: (key: string, value: unknown) => void;
  theme: "light" | "dark";
  setTheme: (t: "light" | "dark") => void;
}

const Ctx = createContext<PreferencesApi | null>(null);

/** Server-side UI preferences (nav colors, etc.), loaded once and shared. */
export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Record<string, unknown>>({});

  useEffect(() => {
    void api
      .get<{ preferences: Record<string, unknown> }>("/settings/preferences")
      .then((r) => setPrefs(r.preferences ?? {}))
      .catch(() => {});
  }, []);

  const setPref = (key: string, value: unknown) => {
    setPrefs((p) => ({ ...p, [key]: value }));
    void api.patch("/settings/preferences", { [key]: value }).catch(() => {});
  };
  const colors = (key: string): NavColors => (prefs[key] as NavColors) ?? {};

  const favorites = Array.isArray(prefs.favorites) ? (prefs.favorites as string[]) : [];
  const isFavorite = (id: string) => favorites.includes(id);
  const toggleFavorite = (id: string) =>
    setPref("favorites", isFavorite(id) ? favorites.filter((x) => x !== id) : [...favorites, id]);

  const banners = (prefs.banners as Record<string, unknown>) ?? {};
  const banner = (key: string) => banners[key];
  const setBanner = (key: string, value: unknown) =>
    setPref("banners", { ...banners, [key]: value ?? undefined });

  const theme: "light" | "dark" = prefs.theme === "dark" ? "dark" : "light";
  const setTheme = (t: "light" | "dark") => {
    setPref("theme", t);
    try {
      localStorage.setItem("hn.theme", t);
    } catch {
      /* ignore */
    }
    document.documentElement.dataset.theme = t;
  };
  // Apply the synced theme once prefs load (and keep localStorage in step for
  // the next no-flash boot).
  useEffect(() => {
    if (prefs.theme === "dark" || prefs.theme === "light") {
      document.documentElement.dataset.theme = prefs.theme;
      try {
        localStorage.setItem("hn.theme", prefs.theme);
      } catch {
        /* ignore */
      }
    }
  }, [prefs.theme]);

  return (
    <Ctx.Provider
      value={{
        prefs,
        setPref,
        colors,
        favorites,
        isFavorite,
        toggleFavorite,
        banner,
        setBanner,
        theme,
        setTheme,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function usePreferences(): PreferencesApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("usePreferences must be used within PreferencesProvider");
  return c;
}
