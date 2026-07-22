import { useEffect, useState } from "react";
import { api, ApiError, type OllamaModel, type Settings } from "../api.ts";
import { useAuth } from "../auth/AuthContext.tsx";
import { AccessKeys } from "../components/AccessKeys.tsx";

interface BackupSettings {
  enabled: boolean;
  time: string;
  keep: number;
}
interface BackupFileInfo {
  file: string;
  bytes: number;
  createdAt: string;
}
interface BackupResult {
  at: string;
  ok: boolean;
  file?: string;
  bytes?: number;
  ms?: number;
  error?: string;
}

const fmtBytes = (n: number): string =>
  n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

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
  const [busy, setBusy] = useState<null | "connect" | "save" | "prefs" | "backup" | "backup-run">(null);

  const [backup, setBackup] = useState<BackupSettings | null>(null);
  const [backupFiles, setBackupFiles] = useState<BackupFileInfo[]>([]);
  const [lastBackup, setLastBackup] = useState<BackupResult | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    void api
      .get<{ settings: BackupSettings; last: BackupResult | null; backups: BackupFileInfo[] }>(
        "/admin/backup",
      )
      .then((r) => {
        setBackup(r.settings);
        setLastBackup(r.last);
        setBackupFiles(r.backups);
      })
      .catch(() => {});
  }, [isAdmin]);

  const saveBackup = async () => {
    if (!backup) return;
    setBusy("backup");
    setError(null);
    setStatus(null);
    try {
      await api.put("/admin/backup", backup);
      setStatus("Backup schedule saved.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not save backup settings");
    } finally {
      setBusy(null);
    }
  };

  const runBackupNow = async () => {
    setBusy("backup-run");
    setError(null);
    setStatus(null);
    try {
      const r = await api.post<{ result: BackupResult; backups: BackupFileInfo[] }>(
        "/admin/backup/run",
        {},
      );
      setLastBackup(r.result);
      setBackupFiles(r.backups);
      setStatus(
        r.result.ok
          ? `Backed up to ${r.result.file} (${fmtBytes(r.result.bytes ?? 0)}).`
          : null,
      );
      if (!r.result.ok) setError(r.result.error ?? "backup failed");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "backup failed");
    } finally {
      setBusy(null);
    }
  };

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

          <div className="card" style={{ marginTop: 24 }}>
            <div className="panel-h" style={{ marginTop: 0 }}>Database backups</div>
            {!backup ? (
              <div className="hint">Loading…</div>
            ) : (
              <>
                <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                  <input
                    type="checkbox"
                    checked={backup.enabled}
                    style={{ width: "auto" }}
                    onChange={(e) => setBackup({ ...backup, enabled: e.target.checked })}
                  />
                  <span>Run a nightly backup</span>
                </label>
                <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
                  <label className="field">
                    <span>At (server time)</span>
                    <input
                      type="time"
                      value={backup.time}
                      onChange={(e) => setBackup({ ...backup, time: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>Keep last</span>
                    <input
                      type="number"
                      min={1}
                      max={365}
                      value={backup.keep}
                      style={{ width: 90 }}
                      onChange={(e) =>
                        setBackup({ ...backup, keep: Math.min(365, Math.max(1, Number(e.target.value) || 1)) })
                      }
                    />
                  </label>
                </div>
                <div className="row" style={{ marginTop: 12, gap: 12 }}>
                  <button className="primary" onClick={() => void saveBackup()} disabled={busy !== null}>
                    {busy === "backup" ? "Saving…" : "Save backup settings"}
                  </button>
                  <button onClick={() => void runBackupNow()} disabled={busy !== null}>
                    {busy === "backup-run" ? "Backing up…" : "Back up now"}
                  </button>
                </div>
                {lastBackup && (
                  <div className={lastBackup.ok ? "hint" : "error"} style={{ marginTop: 10 }}>
                    Last run {new Date(lastBackup.at).toLocaleString()} —{" "}
                    {lastBackup.ok ? `ok (${lastBackup.file})` : lastBackup.error}
                  </div>
                )}
                {backupFiles.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    {backupFiles.map((f) => (
                      <div className="row hint" key={f.file} style={{ gap: 10 }}>
                        <code>{f.file}</code>
                        <span>{fmtBytes(f.bytes)}</span>
                        <span>{new Date(f.createdAt).toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                )}
                <p className="hint" style={{ marginTop: 10 }}>
                  pg_dump (custom format) into <code>backups/</code> in the project root — restore
                  with pg_restore. Requires postgresql-client on the server.
                </p>
              </>
            )}
          </div>
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
