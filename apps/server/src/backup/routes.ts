import { createReadStream } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getBackupConfig, saveBackupConfig } from "../config.js";
import { notFound } from "../lib/errors.js";
import { authenticate, requireAdmin } from "../auth/middleware.js";
import { backupsDir, getLastResult, listBackups, runBackup } from "./service.js";

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

  /** Download one backup file. The name is whitelisted against the actual backup
   *  listing (no path traversal — only a real backup file can be fetched). */
  app.get("/admin/backup/download", async (req, reply) => {
    await requireAdmin(req);
    const { file } = z.object({ file: z.string() }).parse(req.query);
    const files = await listBackups();
    if (!files.some((f) => f.file === file)) throw notFound("backup");
    reply.header("Content-Type", "application/octet-stream");
    reply.header("Content-Disposition", `attachment; filename="${file}"`);
    return reply.send(createReadStream(join(backupsDir, file)));
  });
}
