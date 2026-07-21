import { useEffect, useState } from "react";
import { api, ApiError, type OllamaModel, type Settings } from "../api.ts";
import { useAuth } from "../auth/AuthContext.tsx";
import { AccessKeys } from "../components/AccessKeys.tsx";

const TIMEZONES: string[] = (() => {
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
      .supportedValuesOf;
    return supported ? supported("timeZone") : [];
  } catch {
    return [];
  }
})();

export function SettingsPage() {
  const { user } = useAuth();
  const isAdmin = Boolean(user?.isAdmin);

  const [settings, setSettings] = useState<Settings | null>(null);
  const [url, setUrl] = useState("");
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [embedModel, setEmbedModel] = useState("");
  const [inferenceModel, setInferenceModel] = useState("");
  const [similarity, setSimilarity] = useState(0.75);
  const [timezone, setTimezone] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "connect" | "save" | "prefs">(null);

  useEffect(() => {
    api.get<Settings>("/settings").then((s) => {
      setSettings(s);
      setUrl(s.ollamaUrl ?? "");
      setEmbedModel(s.embedModel ?? "");
      setInferenceModel(s.inferenceModel ?? "");
      setSimilarity(s.defaultSimilarity ?? 0.75);
      setTimezone(s.timezone ?? "");
    });
  }, []);

  const connect = async () => {
    setBusy("connect");
    setError(null);
    setStatus(null);
    try {
      const res = await api.post<{ url: string; models: OllamaModel[] }>(
        "/settings/ollama/models",
        { ollamaUrl: url },
      );
      setModels(res.models);
      setStatus(`Connected — ${res.models.length} model(s) available.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not connect");
      setModels([]);
    } finally {
      setBusy(null);
    }
  };

  const saveOllama = async () => {
    setBusy("save");
    setError(null);
    setStatus(null);
    try {
      const res = await api.put<Settings & { reembedTriggered: boolean }>("/settings", {
        ollamaUrl: url || null,
        embedModel: embedModel || null,
        inferenceModel: inferenceModel || null,
      });
      setSettings(res);
      setStatus(
        res.reembedTriggered
          ? `Saved. Embed model changed → re-embedding all notes (dim ${res.embedDim}).`
          : "Saved.",
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not save");
    } finally {
      setBusy(null);
    }
  };

  const savePrefs = async () => {
    setBusy("prefs");
    setError(null);
    setStatus(null);
    try {
      const res = await api.put<Settings>("/settings", {
        defaultSimilarity: similarity,
        timezone: timezone || null,
      });
      setSettings(res);
      setStatus("Preferences saved.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not save");
    } finally {
      setBusy(null);
    }
  };

  const modelOptions = models.length
    ? models.map((m) => m.name)
    : [embedModel, inferenceModel].filter(Boolean);

  return (
    <>
      <h1 className="page-title">Settings</h1>
      <p className="page-sub">Preferences are stored per-account.</p>

      {isAdmin && (
        <>
          <div className="card">
            <label className="field">
              <span>Ollama URL</span>
              <div className="row">
                <input
                  type="url"
                  placeholder="http://localhost:11434"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
                <button onClick={() => void connect()} disabled={!url || busy !== null}>
                  {busy === "connect" ? "…" : "Connect"}
                </button>
              </div>
            </label>

            <label className="field">
              <span>Embedding model</span>
              <select value={embedModel} onChange={(e) => setEmbedModel(e.target.value)}>
                <option value="">— select —</option>
                {modelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Inference model (reserved — not used yet)</span>
              <select value={inferenceModel} onChange={(e) => setInferenceModel(e.target.value)}>
                <option value="">— none —</option>
                {modelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>

            <div className="row" style={{ marginTop: 12 }}>
              <button className="primary" onClick={() => void saveOllama()} disabled={busy !== null}>
                {busy === "save" ? "Saving…" : "Save Ollama settings"}
              </button>
              {settings?.connected && <span className="pill embedded">connected</span>}
              {settings?.embedDim && <span className="hint">embed dim: {settings.embedDim}</span>}
            </div>
          </div>

          <p className="hint" style={{ marginTop: 8 }}>
            Changing the embedding model re-embeds every note under the new model.
          </p>
        </>
      )}

      <div className="card" style={{ marginTop: isAdmin ? 24 : 0 }}>
        <label className="field">
          <span>Default similarity threshold — {similarity.toFixed(2)}</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={similarity}
            onChange={(e) => setSimilarity(Number(e.target.value))}
          />
          <span className="hint">
            Used for semantic matching where there's no per-search slider (e.g. the Types page).
          </span>
        </label>

        <label className="field">
          <span>Timezone</span>
          <input
            type="text"
            list="hn-timezones"
            placeholder="e.g. America/New_York (blank = server local)"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          />
          <datalist id="hn-timezones">
            {TIMEZONES.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          <span className="hint">Sets the day boundary for the Today sheet's activity list.</span>
        </label>

        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" onClick={() => void savePrefs()} disabled={busy !== null}>
            {busy === "prefs" ? "Saving…" : "Save preferences"}
          </button>
        </div>
      </div>

      {status && <div className="hint" style={{ marginTop: 10 }}>{status}</div>}
      {error && <div className="error" style={{ marginTop: 10 }}>{error}</div>}

      <div style={{ marginTop: 24 }}>
        <AccessKeys />
      </div>
    </>
  );
}
