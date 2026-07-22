import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getBackupConfig, saveBackupConfig } from "../config.js";
import { authenticate, requireAdmin } from "../auth/middleware.js";
import { getLastResult, listBackups, runBackup } from "./service.js";

/** Admin-only: nightly pg_dump schedule + on-demand runs (design: backups/ in repo root). */
export async function backupRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  app.get("/admin/backup", async (req) => {
    await requireAdmin(req);
    return {
      settings: getBackupConfig(),
      last: getLastResult(),
      backups: await listBackups(),
    };
  });

  app.put("/admin/backup", async (req) => {
    await requireAdmin(req);
    const settings = z
      .object({
        enabled: z.boolean(),
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "time must be HH:MM"),
        keep: z.number().int().min(1).max(365),
      })
      .parse(req.body);
    await saveBackupConfig(settings);
    return { settings };
  });

  app.post("/admin/backup/run", async (req) => {
    await requireAdmin(req);
    const result = await runBackup();
    return { result, backups: await listBackups() };
  });
}
