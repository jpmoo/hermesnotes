import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { api, type SetupStatus } from "./api.ts";
import { useAuth } from "./auth/AuthContext.tsx";
import { AuthPage } from "./pages/AuthPage.tsx";
import { InboxPage } from "./pages/InboxPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { SetupPage } from "./pages/SetupPage.tsx";

function Sidebar() {
  const { user, logout } = useAuth();
  return (
    <aside className="sidebar">
      <img className="logo" src="/brand/HermesLogo.png" alt="Hermes Notes" />
      <NavLink to="/" end className="nav-link">
        Inbox
      </NavLink>
      <NavLink to="/settings" className="nav-link">
        Settings
      </NavLink>
      <div className="spacer" />
      <div className="nav-link" style={{ cursor: "default" }}>
        {user?.displayName ?? user?.email}
      </div>
      <button className="ghost" onClick={() => void logout()} style={{ textAlign: "left" }}>
        Sign out
      </button>
    </aside>
  );
}

function ConfiguredApp({ defaultAuthMode }: { defaultAuthMode: "login" | "register" }) {
  const { user, loading } = useAuth();

  if (loading) return <div className="auth-wrap chrome">Loading…</div>;
  if (!user) return <AuthPage defaultMode={defaultAuthMode} />;

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="main">
        <div className="main-inner">
          <Routes>
            <Route path="/" element={<InboxPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}

export function App() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    api
      .get<SetupStatus>("/setup/status")
      .then(setStatus)
      .catch(() => setUnreachable(true));
  }, []);

  if (unreachable) return <div className="auth-wrap chrome">Cannot reach the server.</div>;
  if (!status) return <div className="auth-wrap chrome">Loading…</div>;
  if (!status.configured) return <SetupPage onDone={() => window.location.reload()} />;

  return <ConfiguredApp defaultAuthMode={status.hasUsers ? "login" : "register"} />;
}
