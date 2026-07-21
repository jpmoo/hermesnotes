import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { api, type SetupStatus } from "./api.ts";
import { useAuth } from "./auth/AuthContext.tsx";
import { RightPanel } from "./components/RightPanel.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { RightPanelProvider } from "./lib/right-panel.tsx";
import { AuthPage } from "./pages/AuthPage.tsx";
import { CollectionsPage } from "./pages/CollectionsPage.tsx";
import { CollectionView } from "./pages/CollectionView.tsx";
import { InboxPage } from "./pages/InboxPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { SetupPage } from "./pages/SetupPage.tsx";
import { TypesPage } from "./pages/TypesPage.tsx";

function ConfiguredApp({ defaultAuthMode }: { defaultAuthMode: "login" | "register" }) {
  const { user, loading } = useAuth();

  if (loading) return <div className="auth-wrap chrome">Loading…</div>;
  if (!user) return <AuthPage defaultMode={defaultAuthMode} />;

  return (
    <RightPanelProvider>
      <div className="app-shell">
        <Sidebar />
        <main className="main">
          <div className="main-inner">
            <Routes>
              <Route path="/" element={<InboxPage />} />
              <Route path="/collections" element={<CollectionsPage />} />
              <Route path="/collections/:id" element={<CollectionView />} />
              <Route path="/types" element={<TypesPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
        </main>
        <RightPanel />
      </div>
    </RightPanelProvider>
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
