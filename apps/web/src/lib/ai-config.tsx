import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type Settings } from "../api.ts";

interface AiConfig {
  /** Embedding is possible — Ollama URL + an embed model are configured. Gates
   *  embed-related UI (the per-field "embed" checkboxes). */
  embed: boolean;
  /** The in-app AI assistant is available — Ollama URL + an inference model.
   *  Gates the AI panel tab. */
  ai: boolean;
  loading: boolean;
  refresh: () => void;
}

const Ctx = createContext<AiConfig>({ embed: false, ai: false, loading: true, refresh: () => {} });

/**
 * Whether this instance has local AI models configured. When nothing is set,
 * embedding never runs (the worker is owner-gated server-side) and the UI hides
 * AI affordances — the AI tab and the type-editor embed checkboxes.
 */
export function AiConfigProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = () => {
    void api
      .get<Settings>("/settings")
      .then((s) => setSettings(s))
      .catch(() => setSettings(null))
      .finally(() => setLoading(false));
  };
  useEffect(refresh, []);

  const embed = Boolean(settings?.connected);
  const ai = Boolean(settings?.ollamaUrl && settings?.inferenceModel);

  return <Ctx.Provider value={{ embed, ai, loading, refresh }}>{children}</Ctx.Provider>;
}

export function useAiConfig(): AiConfig {
  return useContext(Ctx);
}
