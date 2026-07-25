import { useEffect, useState, type CSSProperties } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api, type SetupStatus } from "./api.ts";
import { useAuth } from "./auth/AuthContext.tsx";
import { NavBar } from "./components/NavBar.tsx";
import { PageBackground, useHasPageBackground } from "./components/PageBackground.tsx";
import { RouteBannerProvider } from "./lib/route-banner.tsx";
import { RightPanel } from "./components/RightPanel.tsx";
import { useIsMobile } from "./lib/useIsMobile.ts";
import { MobileBar } from "./components/MobileBar.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { PanelsProvider, usePanels } from "./lib/right-panel.tsx";
import { PreferencesProvider, usePreferences } from "./lib/preferences.tsx";
import { AuthPage } from "./pages/AuthPage.tsx";
import { CollectionsPage } from "./pages/CollectionsPage.tsx";
import { CollectionView } from "./pages/CollectionView.tsx";
import { AllBlocksPage } from "./pages/AllBlocksPage.tsx";
import { FavoritesPage } from "./pages/FavoritesPage.tsx";
import { BlockPage } from "./pages/BlockPage.tsx";
import { TodayPage } from "./pages/TodayPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { SetupPage } from "./pages/SetupPage.tsx";
import { TypesPage } from "./pages/TypesPage.tsx";

function ConfiguredApp({ defaultAuthMode }: { defaultAuthMode: "login" | "register" }) {
  const { user, loading } = useAuth();

  if (loading) return <div className="auth-wrap chrome">Loading…</div>;
  if (!user) return <AuthPage defaultMode={defaultAuthMode} />;

  return (
    <PreferencesProvider>
      <PanelsProvider>
        <RouteBannerProvider>
          <Shell />
        </RouteBannerProvider>
      </PanelsProvider>
    </PreferencesProvider>
  );
}

// Which preference key themes each route's window top.
function sectionKey(path: string): string | null {
  if (path === "/") return "inbox_colors";
  if (path.startsWith("/today")) return "today_colors";
  if (path.startsWith("/blocks")) return "allblocks_colors";
  if (path.startsWith("/collections")) return "collections_colors";
  return null;
}

function Shell() {
  const { leftPinned, rightPinned } = usePanels();
  const { colors } = usePreferences();
  const { pathname } = useLocation();
  const isMobile = useIsMobile();
  const hasBg = useHasPageBackground();
  const [navOpen, setNavOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  // Any navigation dismisses the mobile overlays.
  useEffect(() => {
    setNavOpen(false);
    setInfoOpen(false);
  }, [pathname]);
  const key = sectionKey(pathname);
  const c = key ? colors(key) : {};
  const themed = Boolean(c.bg || c.text || c.icon);
  const style = {
    "--section-bg": c.bg ?? "transparent",
    "--section-text": c.text ?? "var(--accent-ink)",
    "--section-icon": c.icon ?? "currentColor",
  } as CSSProperties;

  const shellClass =
    `app-shell${leftPinned ? " left-pinned" : ""}${rightPinned ? " right-pinned" : ""}` +
    (isMobile ? " mobile" : "") +
    (isMobile && navOpen ? " m-nav-open" : "") +
    (isMobile && infoOpen ? " m-info-open" : "") +
    (hasBg ? " has-bg" : "");

  return (
    <div className={shellClass}>
      <PageBackground />
      {isMobile && (
        <MobileBar
          navOpen={navOpen}
          onToggleNav={() => {
            setInfoOpen(false);
            setNavOpen((o) => !o);
          }}
          infoOpen={infoOpen}
          onToggleInfo={() => {
            setNavOpen(false);
            setInfoOpen((o) => !o);
          }}
        />
      )}
      {isMobile && (navOpen || infoOpen) && (
        <div
          className="mobile-backdrop"
          onClick={() => {
            setNavOpen(false);
            setInfoOpen(false);
          }}
        />
      )}
      <Sidebar />
      <main className={`main${themed ? " themed" : ""}`} style={style}>
        {themed && <div className="section-shade" aria-hidden />}
        <div className="main-inner">
          <NavBar />
          <Routes>
            <Route path="/" element={<Navigate to="/blocks" replace />} />
            <Route path="/today" element={<TodayPage />} />
            <Route path="/today/:date" element={<TodayPage />} />
            <Route path="/blocks" element={<AllBlocksPage />} />
            <Route path="/favorites" element={<FavoritesPage />} />
            <Route path="/block/:id" element={<BlockPage />} />
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
