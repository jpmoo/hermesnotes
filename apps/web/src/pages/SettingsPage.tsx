import { useEffect, useState } from "react";
import { api, ApiError, type OllamaModel, type Settings } from "../api.ts";
import { AccessKeys } from "../components/AccessKeys.tsx";

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [url, setUrl] = useState("");
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [embedModel, setEmbedModel] = useState("");
  const [inferenceModel, setInferenceModel] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "connect" | "save">(null);

  useEffect(() => {
    api.get<Settings>("/settings").then((s) => {
      setSettings(s);
      setUrl(s.ollamaUrl ?? "");
      setEmbedModel(s.embedModel ?? "");
      setInferenceModel(s.inferenceModel ?? "");
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

  const save = async () => {
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

  const modelOptions = models.length
    ? models.map((m) => m.name)
    : [embedModel, inferenceModel].filter(Boolean);

  return (
    <>
      <h1 className="page-title">Settings</h1>
      <p className="page-sub">
        Connect your Ollama host and choose models. This is stored per-account, not on the server.
      </p>

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

        {status && <div className="hint">{status}</div>}
        {error && <div className="error">{error}</div>}

        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" onClick={() => void save()} disabled={busy !== null}>
            {busy === "save" ? "Saving…" : "Save settings"}
          </button>
          {settings?.connected && <span className="pill embedded">connected</span>}
          {settings?.embedDim && <span className="hint">embed dim: {settings.embedDim}</span>}
        </div>
      </div>

      <p className="hint" style={{ marginTop: 8 }}>
        Changing the embedding model re-embeds every note under the new model. Models Ollama reports
        aren't tagged embed-vs-chat, so pick the right one for each slot.
      </p>

      <div style={{ marginTop: 24 }}>
        <AccessKeys />
      </div>
    </>
  );
}
