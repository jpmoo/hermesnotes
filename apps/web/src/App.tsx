import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { api, type SetupStatus } from "./api.ts";
import { useAuth } from "./auth/AuthContext.tsx";
import { RightPanel } from "./components/RightPanel.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { PanelsProvider, usePanels } from "./lib/right-panel.tsx";
import { AuthPage } from "./pages/AuthPage.tsx";
import { CollectionsPage } from "./pages/CollectionsPage.tsx";
import { CollectionView } from "./pages/CollectionView.tsx";
import { AllBlocksPage } from "./pages/AllBlocksPage.tsx";
import { UnattachedPage } from "./pages/UnattachedPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { SetupPage } from "./pages/SetupPage.tsx";
import { TypesPage } from "./pages/TypesPage.tsx";

function ConfiguredApp({ defaultAuthMode }: { defaultAuthMode: "login" | "register" }) {
  const { user, loading } = useAuth();

  if (loading) return <div className="auth-wrap chrome">Loading…</div>;
  if (!user) return <AuthPage defaultMode={defaultAuthMode} />;

  return (
    <PanelsProvider>
      <Shell />
    </PanelsProvider>
  );
}

function Shell() {
  const { leftPinned, rightPinned } = usePanels();
  return (
    <div
      className={`app-shell${leftPinned ? " left-pinned" : ""}${rightPinned ? " right-pinned" : ""}`}
    >
      <Sidebar />
      <main className="main">
        <div className="main-inner">
          <Routes>
            <Route path="/" element={<UnattachedPage />} />
            <Route path="/blocks" element={<AllBlocksPage />} />
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
