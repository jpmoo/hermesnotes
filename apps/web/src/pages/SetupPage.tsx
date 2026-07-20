import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api.ts";

/**
 * First-run wizard. Collects a privileged Postgres connection (used once to
 * create the app role + database, never stored) and the new application
 * database credentials to create. On success the server migrates, connects,
 * and the app flows on to account creation.
 */
export function SetupPage({ onDone }: { onDone: () => void }) {
  const [adminHost, setAdminHost] = useState("localhost");
  const [adminPort, setAdminPort] = useState("5432");
  const [adminUser, setAdminUser] = useState("postgres");
  const [adminPassword, setAdminPassword] = useState("");
  const [adminDatabase, setAdminDatabase] = useState("postgres");
  const [adminSsl, setAdminSsl] = useState(false);

  const [dbName, setDbName] = useState("hermes");
  const [appUser, setAppUser] = useState("hermes");
  const [appPassword, setAppPassword] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/setup/database", {
        admin: {
          host: adminHost,
          port: Number(adminPort),
          user: adminUser,
          password: adminPassword,
          database: adminDatabase,
          ssl: adminSsl,
        },
        app: { dbName, user: appUser, password: appPassword },
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "setup failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <form className="auth-card" style={{ maxWidth: 440 }} onSubmit={submit}>
        <img className="logo" src={`${import.meta.env.BASE_URL}brand/HermesLogoSmall.png`} alt="Hermes Notes" />
        <h2 className="chrome" style={{ margin: "0 0 4px", fontSize: 16 }}>
          Set up the database
        </h2>
        <p className="hint" style={{ marginBottom: 18 }}>
          Provide a PostgreSQL admin login (needs permission to create roles and
          databases). It's used once to create the app database and isn't stored.
        </p>

        <div className="row">
          <label className="field" style={{ flex: 2 }}>
            <span>Admin host</span>
            <input type="text" value={adminHost} onChange={(e) => setAdminHost(e.target.value)} />
          </label>
          <label className="field" style={{ flex: 1 }}>
            <span>Port</span>
            <input type="text" value={adminPort} onChange={(e) => setAdminPort(e.target.value)} />
          </label>
        </div>
        <label className="field">
          <span>Admin user</span>
          <input type="text" value={adminUser} onChange={(e) => setAdminUser(e.target.value)} />
        </label>
        <label className="field">
          <span>Admin password</span>
          <input
            type="password"
            value={adminPassword}
            onChange={(e) => setAdminPassword(e.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>Maintenance database</span>
          <input
            type="text"
            value={adminDatabase}
            onChange={(e) => setAdminDatabase(e.target.value)}
          />
        </label>
        <label className="field" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={adminSsl}
            onChange={(e) => setAdminSsl(e.target.checked)}
            style={{ width: "auto" }}
          />
          <span style={{ margin: 0 }}>Require SSL</span>
        </label>

        <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "16px 0" }} />
        <p className="hint" style={{ marginBottom: 14 }}>
          New application database to create:
        </p>
        <label className="field">
          <span>Database name</span>
          <input type="text" value={dbName} onChange={(e) => setDbName(e.target.value)} />
        </label>
        <label className="field">
          <span>App database user</span>
          <input type="text" value={appUser} onChange={(e) => setAppUser(e.target.value)} />
        </label>
        <label className="field">
          <span>App database password</span>
          <input
            type="password"
            value={appPassword}
            onChange={(e) => setAppPassword(e.target.value)}
            required
          />
        </label>

        {error && <div className="error">{error}</div>}
        <button className="primary" type="submit" disabled={busy} style={{ width: "100%" }}>
          {busy ? "Creating database…" : "Create database & continue"}
        </button>
      </form>
    </div>
  );
}
