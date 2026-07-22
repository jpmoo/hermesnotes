import { useEffect, useState } from "react";
import { api, ApiError, type AccessKey, type CreatedAccessKey } from "../api.ts";

/** Build the fragment-based skip-login URL for a freshly created key. */
function keyUrl(token: string): string {
  // BASE_URL is the subpath mount (e.g. "/hermesnotes/").
  return `${window.location.origin}${import.meta.env.BASE_URL}#k=${encodeURIComponent(token)}`;
}

export function AccessKeys() {
  const [keys, setKeys] = useState<AccessKey[]>([]);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<CreatedAccessKey | null>(null);
  const [copied, setCopied] = useState<null | "link" | "key">(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.get<AccessKey[]>("/auth/tokens").then(setKeys);

  useEffect(() => {
    load().catch((err) => setError(err instanceof ApiError ? err.message : "load failed"));
  }, []);

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    setCopied(null);
    try {
      const key = await api.post<CreatedAccessKey>("/auth/tokens", { name: name.trim() });
      setCreated(key);
      setName("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not create key");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    await api.del(`/auth/tokens/${id}`);
    if (created?.id === id) setCreated(null);
    await load();
  };

  const copy = async (what: "link" | "key") => {
    if (!created) return;
    await navigator.clipboard.writeText(what === "link" ? keyUrl(created.token) : created.token);
    setCopied(what);
  };

  return (
    <div className="card">
      <h2 className="chrome" style={{ margin: "0 0 4px", fontSize: 15 }}>
        Access keys
      </h2>
      <p className="hint" style={{ marginBottom: 14 }}>
        A link that skips login — open the URL and you're signed in on that device. The raw key
        also works as an API bearer token (e.g. for the MCP server). Anyone with it has full
        access until you revoke it — treat it like a password.
      </p>

      <div className="row" style={{ marginBottom: 14 }}>
        <input
          type="text"
          placeholder="Key name (e.g. laptop, phone)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="primary" onClick={() => void create()} disabled={busy || !name.trim()}>
          Create
        </button>
      </div>

      {created && (
        <div
          className="card"
          style={{ background: "var(--surface-2)", marginBottom: 14, boxShadow: "none" }}
        >
          <div className="hint" style={{ marginBottom: 6 }}>
            Copy this now — it won't be shown again.
          </div>
          <div
            style={{
              fontFamily: "monospace",
              fontSize: 12,
              wordBreak: "break-all",
              marginBottom: 8,
            }}
          >
            {keyUrl(created.token)}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button onClick={() => void copy("link")}>
              {copied === "link" ? "Copied ✓" : "Copy login link"}
            </button>
            <button onClick={() => void copy("key")}>
              {copied === "key" ? "Copied ✓" : "Copy key (for API/MCP)"}
            </button>
          </div>
        </div>
      )}

      {error && <div className="error">{error}</div>}

      {keys.length === 0 ? (
        <div className="hint">No access keys yet.</div>
      ) : (
        keys.map((k) => (
          <div
            key={k.id}
            className="row"
            style={{ padding: "8px 0", borderTop: "1px solid var(--border)" }}
          >
            <div style={{ flex: 1 }}>
              <div className="chrome" style={{ fontSize: 13 }}>
                {k.name}
              </div>
              <div className="hint">
                {k.lastUsedAt ? `last used ${new Date(k.lastUsedAt).toLocaleString()}` : "never used"}
              </div>
            </div>
            <button className="ghost" onClick={() => void revoke(k.id)}>
              Revoke
            </button>
          </div>
        ))
      )}
    </div>
  );
}
