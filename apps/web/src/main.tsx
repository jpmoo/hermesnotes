import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.tsx";
import { AuthProvider } from "./auth/AuthContext.tsx";
import "./styles.css";

// Apply the saved theme before first paint to avoid a flash.
try {
  const mobile = window.matchMedia("(max-width: 720px)").matches;
  const t = localStorage.getItem(mobile ? "hn.theme.mobile" : "hn.theme");
  if (t === "dark" || t === "light") document.documentElement.dataset.theme = t;
} catch {
  /* ignore */
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "")}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
