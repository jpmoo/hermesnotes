import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "./env.js";
import { initDb } from "./db.js";

/**
 * Runtime configuration that may be established by the first-run web setup
 * rather than the environment. Persisted to a 0600 JSON file so the app can
 * come up unconfigured, be provisioned from the browser, and remember the
 * result across restarts. Environment variables always take precedence.
 */
interface PersistedConfig {
  databaseUrl?: string;
  authSecret?: string;
  backup?: BackupConfig;
  /** Whether anyone can self-register. The first account always may (bootstrap). */
  allowRegistration?: boolean;
}

/** Nightly pg_dump settings (admin-editable; instance-wide). */
export interface BackupConfig {
  enabled: boolean;
  /** Local server time, "HH:MM". */
  time: string;
  /** How many dump files to retain. */
  keep: number;
}

const DEFAULT_BACKUP: BackupConfig = { enabled: false, time: "03:30", keep: 14 };

// Repo-root-relative so it's stable regardless of launch cwd (see load-env.ts).
// Exported as the single source of truth — path math from import.meta.url is
// depth-sensitive, and duplicating it in deeper files gets the count wrong.
export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const configPath =
  process.env.HERMES_CONFIG_PATH ?? join(repoRoot, "data", "hermes.config.json");

let state:
  | { databaseUrl?: string; authSecret: string; backup: BackupConfig; allowRegistration: boolean }
  | null = null;

async function readFileConfig(): Promise<PersistedConfig> {
  try {
    return JSON.parse(await readFile(configPath, "utf8")) as PersistedConfig;
  } catch {
    return {};
  }
}

async function persist(): Promise<void> {
  if (!state) return;
  await mkdir(dirname(configPath), { recursive: true });
  const out: PersistedConfig = {
    authSecret: state.authSecret,
    backup: state.backup,
    allowRegistration: state.allowRegistration,
  };
  if (state.databaseUrl) out.databaseUrl = state.databaseUrl;
  await writeFile(configPath, JSON.stringify(out, null, 2), { mode: 0o600 });
}

/** Load env + file, ensure an auth secret exists, and connect the DB if known. */
export async function initConfig(): Promise<void> {
  const file = await readFileConfig();
  const authSecret = env.AUTH_SECRET ?? file.authSecret ?? randomBytes(48).toString("base64");
  const databaseUrl = env.DATABASE_URL ?? file.databaseUrl;
  state = {
    databaseUrl,
    authSecret,
    backup: { ...DEFAULT_BACKUP, ...file.backup },
    allowRegistration: file.allowRegistration ?? true,
  };

  // Persist a freshly generated secret (or newly-adopted file state).
  if (!env.AUTH_SECRET && file.authSecret !== authSecret) await persist();

  if (databaseUrl) initDb(databaseUrl);
}

export function getAuthSecret(): string {
  if (!state) throw new Error("config not initialized");
  return state.authSecret;
}

export function getDatabaseUrl(): string | undefined {
  return state?.databaseUrl;
}

export function getBackupConfig(): BackupConfig {
  if (!state) throw new Error("config not initialized");
  return state.backup;
}

export async function saveBackupConfig(next: BackupConfig): Promise<void> {
  if (!state) throw new Error("config not initialized");
  state.backup = next;
  await persist();
}

export function getAllowRegistration(): boolean {
  return state?.allowRegistration ?? true;
}

export async function saveAllowRegistration(next: boolean): Promise<void> {
  if (!state) throw new Error("config not initialized");
  state.allowRegistration = next;
  await persist();
}

/** Record a newly provisioned app connection and connect the live pool to it. */
export async function saveDatabaseUrl(url: string): Promise<void> {
  if (!state) throw new Error("config not initialized");
  state.databaseUrl = url;
  await persist();
  initDb(url);
}
