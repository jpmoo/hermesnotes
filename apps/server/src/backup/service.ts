import { execFile } from "node:child_process";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { getBackupConfig, getDatabaseUrl, repoRoot } from "../config.js";

const execFileP = promisify(execFile);

export const backupsDir = process.env.HERMES_BACKUP_DIR ?? join(repoRoot, "backups");

export interface BackupResult {
  at: string; // ISO
  ok: boolean;
  file?: string;
  bytes?: number;
  ms?: number;
  error?: string;
}

export interface BackupFile {
  file: string;
  bytes: number;
  createdAt: string;
}

let running = false;
let lastResult: BackupResult | null = null;

export const getLastResult = (): BackupResult | null => lastResult;

const stamp = (d: Date): string =>
  [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("") +
  "-" +
  [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join("");

/** Dumps sorted newest-first. Only files this service wrote (hermes-*.dump). */
export async function listBackups(): Promise<BackupFile[]> {
  let names: string[];
  try {
    names = await readdir(backupsDir);
  } catch {
    return [];
  }
  const files = await Promise.all(
    names
      .filter((n) => /^hermes-\d{8}-\d{6}\.dump$/.test(n))
      .map(async (n) => {
        const s = await stat(join(backupsDir, n));
        return { file: n, bytes: s.size, createdAt: s.mtime.toISOString() };
      }),
  );
  return files.sort((a, b) => b.file.localeCompare(a.file));
}

/** Delete dumps beyond the newest `keep`. */
async function prune(keep: number): Promise<void> {
  const files = await listBackups();
  for (const f of files.slice(Math.max(1, keep))) {
    await unlink(join(backupsDir, f.file)).catch(() => {});
  }
}

/**
 * Run pg_dump (custom format — compressed, restorable with pg_restore) into
 * the backups folder, then prune to the retention count. Serialized: a run
 * that overlaps an in-flight one is refused.
 */
export async function runBackup(): Promise<BackupResult> {
  const url = getDatabaseUrl();
  if (!url) {
    return (lastResult = { at: new Date().toISOString(), ok: false, error: "database not configured" });
  }
  if (running) {
    return { at: new Date().toISOString(), ok: false, error: "a backup is already running" };
  }
  running = true;
  const started = Date.now();
  const file = `hermes-${stamp(new Date())}.dump`;
  const path = join(backupsDir, file);
  try {
    await mkdir(backupsDir, { recursive: true });
    await execFileP("pg_dump", ["--format=custom", "--file", path, url], {
      timeout: 15 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const s = await stat(path);
    await prune(getBackupConfig().keep);
    return (lastResult = {
      at: new Date().toISOString(),
      ok: true,
      file,
      bytes: s.size,
      ms: Date.now() - started,
    });
  } catch (err) {
    // A failed run must not leave a truncated dump that later looks restorable.
    await unlink(path).catch(() => {});
    const msg =
      err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT"
        ? "pg_dump not found on the server — install postgresql-client"
        : err instanceof Error
          ? err.message
          : String(err);
    return (lastResult = { at: new Date().toISOString(), ok: false, error: msg, ms: Date.now() - started });
  } finally {
    running = false;
  }
}
