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

  return <Ctx.Provider value={{ prefs, setPref, colors }}>{children}</Ctx.Provider>;
}

export function usePreferences(): PreferencesApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("usePreferences must be used within PreferencesProvider");
  return c;
}
