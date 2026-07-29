import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// The app serves at the root of its origin by default (http://host:PORT/). To
// host it under a subpath — e.g. behind a reverse proxy at example.com/notes —
// set APP_BASE_PATH=/notes/ in the repo-root .env before building. Everything
// (asset URLs, the MCP endpoint) derives from this automatically.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  const base = env.APP_BASE_PATH || "/";
  const prefix = base.replace(/\/$/, ""); // "" at root, "/notes" for a subpath
  return {
    base,
    plugins: [react()],
    server: {
      port: 5173,
      // Dev only: forward API calls to the running server, stripping any subpath
      // prefix so the server sees plain /api (mirrors a subpath reverse proxy).
      proxy: {
        [`${prefix}/api`]: {
          target: env.DEV_SERVER_URL || "http://localhost:8089",
          changeOrigin: true,
          ...(prefix ? { rewrite: (p: string) => p.replace(prefix, "") } : {}),
        },
      },
    },
  };
});
