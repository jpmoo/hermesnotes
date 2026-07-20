import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The app is hosted under a subpath (Caddy: app.schoolahead.today/hermesnotes).
// Change this if the mount point changes; everything else reads it via
// import.meta.env.BASE_URL.
const BASE = "/hermesnotes/";

export default defineConfig({
  base: BASE,
  plugins: [react()],
  server: {
    port: 5173,
    // Mirror the production Caddy setup in dev: strip the subpath prefix and
    // forward API calls to the server (default :8089).
    proxy: {
      [`${BASE}api`]: {
        target: "http://localhost:8089",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/hermesnotes/, ""),
      },
    },
  },
});
