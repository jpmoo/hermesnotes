import { createDb, type Database } from "@hermes/db";

/**
 * Live database handle. The connection isn't known at import time — it may be
 * established by the first-run setup flow — so `db` is a Proxy that forwards to
 * whatever pool is currently active. Every module can `import { db }` and keep
 * working across a (re)connect.
 */
let current: Database | null = null;
let currentClose: (() => Promise<void>) | null = null;

export function initDb(url: string): void {
  if (currentClose) void currentClose().catch(() => {});
  const { db, sql } = createDb(url);
  current = db;
  currentClose = () => sql.end({ timeout: 5 });
}

export function isDbReady(): boolean {
  return current !== null;
}

export const db = new Proxy({} as Database, {
  get(_target, prop) {
    if (!current) throw new Error("database is not configured");
    const value = (current as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === "function" ? value.bind(current) : value;
  },
}) as Database;
