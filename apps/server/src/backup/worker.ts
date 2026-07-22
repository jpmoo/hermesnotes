import type { FastifyBaseLogger } from "fastify";
import { getBackupConfig } from "../config.js";
import { isDbReady } from "../db.js";
import { runBackup } from "./service.js";

const TICK_MS = 30_000;

/**
 * Scheduled-backup worker: fires pg_dump once per day when the server's local
 * wall clock passes the configured HH:MM. A tick that lands inside the target
 * minute runs it; the day-stamp guard stops repeats within that minute.
 */
export function startBackupWorker(log: FastifyBaseLogger): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let lastRunDay = ""; // YYYY-MM-DD of the last scheduled fire

  const tick = async () => {
    if (stopped) return;
    try {
      const cfg = getBackupConfig();
      if (cfg.enabled && isDbReady()) {
        const now = new Date();
        const hhmm =
          `${String(now.getHours()).padStart(2, "0")}:` + String(now.getMinutes()).padStart(2, "0");
        const day = now.toISOString().slice(0, 10);
        if (hhmm === cfg.time && lastRunDay !== day) {
          lastRunDay = day;
          const res = await runBackup();
          if (res.ok) log.info({ file: res.file, bytes: res.bytes, ms: res.ms }, "scheduled backup done");
          else log.error({ error: res.error }, "scheduled backup failed");
        }
      }
    } catch (err) {
      log.error({ err }, "backup worker tick error");
    }
    if (!stopped) timer = setTimeout(tick, TICK_MS);
  };

  log.info("backup worker started");
  timer = setTimeout(tick, TICK_MS);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
