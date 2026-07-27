import type { FastifyBaseLogger } from "fastify";
import { and, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { isComplete } from "@hermes/shared";
import { blocks, blockTypes, userSettings } from "@hermes/db";
import { db, isDbReady } from "../db.js";

const TICK_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * Auto-archive completed tasks. For each user who set `autoarchiveDoneDays`,
 * archive active, completed blocks whose `done_at` (stamped when status entered
 * a complete value) is older than that many days. Runs once per day.
 */
export async function runAutoArchive(): Promise<number> {
  const users = await db
    .select({ userId: userSettings.userId, days: userSettings.autoarchiveDoneDays })
    .from(userSettings)
    .where(and(isNotNull(userSettings.autoarchiveDoneDays), sql`${userSettings.autoarchiveDoneDays} > 0`));
  let archived = 0;
  for (const u of users) {
    const days = u.days ?? 0;
    if (days <= 0) continue;
    const cutoff = new Date(Date.now() - days * DAY_MS).toISOString();
    // The types whose schema marks completion, so we only scan real tasks.
    const types = await db
      .select({ id: blockTypes.id, schema: blockTypes.propertySchema })
      .from(blockTypes)
      .where(eq(blockTypes.ownerId, u.userId));
    const done = new Map(types.map((t) => [t.id, t.schema]));

    const rows = await db
      .select({ id: blocks.id, blockTypeId: blocks.blockTypeId, properties: blocks.properties })
      .from(blocks)
      .where(
        and(
          eq(blocks.ownerId, u.userId),
          isNull(blocks.archivedAt),
          sql`${blocks.collectionKind} IS NULL`,
          // done_at is a stored ISO string; compare lexically (ISO sorts by time).
          lt(sql`${blocks.properties}->>'done_at'`, cutoff),
        ),
      );
    const toArchive = rows
      .filter((r) => {
        const schema = r.blockTypeId ? done.get(r.blockTypeId) : null;
        return schema ? isComplete(schema, r.properties as Record<string, unknown>) : false;
      })
      .map((r) => r.id);
    for (const id of toArchive) {
      await db
        .update(blocks)
        .set({ archivedAt: new Date(), version: sql`${blocks.version} + 1` })
        .where(and(eq(blocks.id, id), eq(blocks.ownerId, u.userId), isNull(blocks.archivedAt)));
      archived++;
    }
  }
  return archived;
}

/** Daily auto-archive worker. Fires once per calendar day (server local). */
export function startAutoArchiveWorker(log: FastifyBaseLogger): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let lastRunDay = "";

  const tick = async () => {
    if (stopped) return;
    try {
      if (isDbReady()) {
        const day = new Date().toISOString().slice(0, 10);
        // Runs shortly after midnight-ish: any tick on a new day triggers it.
        if (lastRunDay !== day) {
          lastRunDay = day;
          const n = await runAutoArchive();
          if (n > 0) log.info({ archived: n }, "auto-archive swept completed tasks");
        }
      }
    } catch (err) {
      log.error({ err }, "auto-archive worker tick error");
    }
    if (!stopped) timer = setTimeout(tick, TICK_MS);
  };

  log.info("auto-archive worker started");
  timer = setTimeout(tick, TICK_MS);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
