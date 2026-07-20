import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

/**
 * Load the repo-root .env before any module reads process.env. Imported first
 * in server.ts. Path is resolved relative to this file (not cwd) so it works
 * regardless of how the process is launched — e.g. `pnpm --filter` sets the
 * child cwd to apps/server, but .env lives at the repo root.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
config({ path: join(repoRoot, ".env") });
