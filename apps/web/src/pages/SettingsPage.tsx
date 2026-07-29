import { CalendarDays, Copy, Download, KeyRound, ListChecks, Palette, Settings2, ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, apiBase, ApiError, type OllamaModel, type Settings } from "../api.ts";
import { useAuth } from "../auth/AuthContext.tsx";
import { usePreferences } from "../lib/preferences.tsx";
import { Banner, BannerAddButton, type BannerValue } from "../components/Banner.tsx";
import { AccessKeys } from "../components/AccessKeys.tsx";
import { BackgroundSettings } from "../components/BackgroundSettings.tsx";
import { ListSettings } from "../components/ListSettings.tsx";
import { RailEditor } from "../components/RailEditor.tsx";
import { CalendarFeedsSettings } from "../components/CalendarFeedsSettings.tsx";
import { UserManagement } from "../components/UserManagement.tsx";
import { WeeklyReviewSettings } from "../components/WeeklyReviewSettings.tsx";
import { ExportSettings } from "../components/ExportSettings.tsx";

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
interface EmbeddingStats {
  total: number;
  embeddable: number;
  embedded: number;
  pending: number;
  connected: boolean;
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

type SettingsTab = "general" | "review" | "appearance" | "calendar" | "access" | "export" | "admin";

const readSettingsTab = (isAdmin: boolean): SettingsTab => {
  try {
    const v = localStorage.getItem("hn.settings.tab");
    if (v === "review" || v === "appearance" || v === "calendar" || v === "access" || v === "export") return v;
    if (v === "admin" && isAdmin) return "admin";
  } catch {
    /* ignore */
  }
  return "general";
};

export function SettingsPage() {
  const { user } = useAuth();
  const isAdmin = Boolean(user?.isAdmin);
  const { banner, setBanner } = usePreferences();
  const settingsBanner = banner("settings") as BannerValue | null;

  const [tab, setTabRaw] = useState<SettingsTab>(() => readSettingsTab(isAdmin));
  const setTab = (t: SettingsTab) => {
    setTabRaw(t);
    try {
      localStorage.setItem("hn.settings.tab", t);
    } catch {
      /* ignore */
    }
  };

  const [settings, setSettings] = useState<Settings | null>(null);
  const [url, setUrl] = useState("");
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [embedModel, setEmbedModel] = useState("");
  const [inferenceModel, setInferenceModel] = useState("");
  const [similarity, setSimilarity] = useState(0.75);
  const [timezone, setTimezone] = useState("");
  const [autoDays, setAutoDays] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<
    null | "connect" | "save" | "prefs" | "backup" | "backup-run" | "archive-now" | "reembed"
  >(null);

  const [backup, setBackup] = useState<BackupSettings | null>(null);
  const [backupFiles, setBackupFiles] = useState<BackupFileInfo[]>([]);
  const [lastBackup, setLastBackup] = useState<BackupResult | null>(null);
  const [embStats, setEmbStats] = useState<EmbeddingStats | null>(null);

  const loadEmbeddings = () =>
    void api.get<EmbeddingStats>("/admin/embeddings").then(setEmbStats).catch(() => {});

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
    loadEmbeddings();
  }, [isAdmin]);

  const reembedAll = async () => {
    setBusy("reembed");
    setError(null);
    setStatus(null);
    try {
      const r = await api.post<{ queued: number }>("/admin/embeddings/reembed", {});
      setStatus(`Queued ${r.queued} block(s) for re-embedding. This runs in the background.`);
      loadEmbeddings();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not queue re-embedding");
    } finally {
      setBusy(null);
    }
  };

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
      setAutoDays(s.autoarchiveDoneDays ?? 0);
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

  const archiveNow = async () => {
    setBusy("archive-now");
    setError(null);
    setStatus(null);
    try {
      const r = await api.post<{ archived: number }>("/settings/archive-completed", {});
      setStatus(
        r.archived > 0
          ? `Archived ${r.archived} completed task${r.archived > 1 ? "s" : ""}.`
          : "No completed tasks to archive.",
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not archive");
    } finally {
      setBusy(null);
    }
  };

  // The low-risk general settings auto-save (like Appearance), debounced so a
  // slider drag or fast typing coalesces into one request. (Side-effect-heavy
  // settings — Ollama models, backups, weekly review — keep an explicit Save.)
  const prefsTimer = useRef<ReturnType<typeof setTimeout>>();
  const pendingPrefs = useRef<Record<string, unknown>>({});
  const autoSaveSetting = (patch: Record<string, unknown>) => {
    pendingPrefs.current = { ...pendingPrefs.current, ...patch };
    if (prefsTimer.current) clearTimeout(prefsTimer.current);
    prefsTimer.current = setTimeout(() => {
      const body = pendingPrefs.current;
      pendingPrefs.current = {};
      void api
        .put<Settings>("/settings", body)
        .then(setSettings)
        .catch((err) => setError(err instanceof ApiError ? err.message : "could not save"));
    }, 500);
  };

  const modelOptions = models.length
    ? models.map((m) => m.name)
    : [embedModel, inferenceModel].filter(Boolean);

  // The MCP endpoint is mounted at <app>/mcp behind the same reverse-proxy entry
  // (BASE_URL is the subpath mount, e.g. "/hermesnotes/").
  const mcpUrl = `${window.location.origin}${import.meta.env.BASE_URL}mcp`;

  const tabs: { key: SettingsTab; label: string; Icon: typeof Settings2; admin?: boolean }[] = [
    { key: "general", label: "General", Icon: Settings2 },
    { key: "review", label: "Weekly Review", Icon: ListChecks },
    { key: "appearance", label: "Appearance", Icon: Palette },
    { key: "calendar", label: "Calendar", Icon: CalendarDays },
    { key: "access", label: "Access Keys", Icon: KeyRound },
    { key: "export", label: "Export", Icon: Download },
    ...(isAdmin ? [{ key: "admin" as const, label: "Admin", Icon: ShieldAlert, admin: true }] : []),
  ];

  return (
    <>
      {settingsBanner && (
        <Banner value={settingsBanner} editable onChange={(v) => setBanner("settings", v)} />
      )}
      <div className="page-head">
        <h1 className="page-title">Settings</h1>
        {!settingsBanner && (
          <BannerAddButton className="page-head-add" onAdded={(v) => setBanner("settings", v)} />
        )}
      </div>
      <p className="page-sub">Preferences are stored per-account.</p>

      <div className="settings-tabs">
        {tabs.map(({ key, label, Icon, admin }) => (
          <button
            key={key}
            className={`settings-tab${admin ? " admin" : ""}${tab === key ? " active" : ""}`}
            onClick={() => setTab(key)}
          >
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      {tab === "admin" && isAdmin && (
        <>
          <div className="card">
            <div className="panel-h" style={{ marginTop: 0 }}>MCP Server</div>
            <p style={{ margin: "0 0 6px" }}>MCP Server is active at:</p>
            <div className="info-id">
              <code>{mcpUrl}</code>
              <button
                className="icon-btn"
                title="Copy MCP URL"
                onClick={() => void navigator.clipboard?.writeText(mcpUrl)}
              >
                <Copy size={12} />
              </button>
            </div>
          </div>

          <div className="card" style={{ marginTop: 24 }}>
            <div className="panel-h" style={{ marginTop: 0 }}>Embeddings</div>
            {embStats ? (
              <>
                <p style={{ margin: "0 0 4px" }}>
                  <strong>
                    {embStats.embedded} of {embStats.embeddable}
                  </strong>{" "}
                  embeddable blocks have embeddings
                  {embStats.pending > 0 ? ` — ${embStats.pending} pending` : ""}.
                </p>
                <p className="hint" style={{ marginTop: 0 }}>
                  {embStats.total} blocks total (empty ones aren’t embedded). Semantic search uses
                  these vectors.
                  {!embStats.connected && " No embed model is configured — nothing can embed yet."}
                </p>
                <div className="row" style={{ marginTop: 10 }}>
                  <button onClick={() => void reembedAll()} disabled={busy !== null}>
                    {busy === "reembed" ? "Queuing…" : "Embed again"}
                  </button>
                  <button className="ghost" onClick={loadEmbeddings} disabled={busy !== null}>
                    Refresh
                  </button>
                </div>
              </>
            ) : (
              <p className="hint" style={{ margin: 0 }}>Loading…</p>
            )}
          </div>

          <div className="card" style={{ marginTop: 24 }}>
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
                <label className="row" style={{ gap: 10, alignItems: "center", marginBottom: 14, cursor: "pointer" }}>
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
                        <a
                          className="icon-btn"
                          style={{ marginLeft: "auto" }}
                          href={`${apiBase}/admin/backup/download?file=${encodeURIComponent(f.file)}`}
                          download={f.file}
                          title={`Download ${f.file}`}
                          aria-label={`Download ${f.file}`}
                        >
                          <Download size={15} />
                        </a>
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

          <UserManagement />
        </>
      )}

      {tab === "general" && (
      <div className="card">
        <label className="field">
          <span>Default similarity threshold — {similarity.toFixed(2)}</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={similarity}
            onChange={(e) => {
              const v = Number(e.target.value);
              setSimilarity(v);
              autoSaveSetting({ defaultSimilarity: v });
            }}
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
            onChange={(e) => {
              setTimezone(e.target.value);
              autoSaveSetting({ timezone: e.target.value || null });
            }}
          />
          <datalist id="hn-timezones">
            {TIMEZONES.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          <span className="hint">Sets the day boundary for the Today sheet's activity list.</span>
        </label>

        <label className="field" style={{ marginTop: 16 }}>
          <span>Auto-archive completed tasks</span>
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <span className="hint">After</span>
            <input
              type="number"
              min={0}
              max={3650}
              value={autoDays}
              style={{ width: 90 }}
              onChange={(e) => {
                const v = Math.min(3650, Math.max(0, Number(e.target.value) || 0));
                setAutoDays(v);
                autoSaveSetting({ autoarchiveDoneDays: v > 0 ? v : null });
              }}
            />
            <span className="hint">days done (0 = off)</span>
          </div>
          <span className="hint">
            A daily job archives tasks that have been marked done for this many days. They move to the
            Archive, not deleted.
          </span>
        </label>

        <div className="row" style={{ marginTop: 12, gap: 12 }}>
          <span className="hint" style={{ marginRight: "auto" }}>Changes here save automatically.</span>
          <button onClick={() => void archiveNow()} disabled={busy !== null} title="Archive all completed tasks now">
            {busy === "archive-now" ? "Archiving…" : "Archive completed now"}
          </button>
        </div>
      </div>
      )}

      {tab === "review" && <WeeklyReviewSettings />}
      {tab === "appearance" && (
        <>
          <BackgroundSettings />
          <div style={{ marginTop: 24 }}>
            <ListSettings />
          </div>
          <div style={{ marginTop: 24 }}>
            <RailEditor />
          </div>
        </>
      )}
      {tab === "calendar" && <CalendarFeedsSettings />}
      {tab === "access" && <AccessKeys />}

      {tab === "export" && <ExportSettings />}

      {status && <div className="hint" style={{ marginTop: 10 }}>{status}</div>}
      {error && <div className="error" style={{ marginTop: 10 }}>{error}</div>}
    </>
  );
}
