import type { FastifyBaseLogger } from "fastify";
import { isDbReady } from "../db.js";
import { embedBlock, fetchStaleBatch } from "./service.js";

const BATCH = 25;
const IDLE_MS = 4000; // poll cadence when there's nothing to do
const BUSY_MS = 250; // brief breather between batches when catching up

/**
 * Background embedding worker. Polls hash-gated stale blocks and embeds them
 * against each owner's configured Ollama host. Per-block failures (e.g. Ollama
 * unreachable) are logged and left stale for the next pass — nothing blocks.
 */
export function startEmbeddingWorker(log: FastifyBaseLogger): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    if (stopped) return;
    // Nothing to do until the first-run setup has connected a database.
    if (!isDbReady()) {
      timer = setTimeout(tick, IDLE_MS);
      return;
    }
    let processed = 0;
    try {
      const batch = await fetchStaleBatch(BATCH);
      for (const row of batch) {
        if (stopped) break;
        try {
          await embedBlock(row);
          processed++;
        } catch (err) {
          log.warn({ err, blockId: row.id }, "embedding failed; will retry");
        }
      }
    } catch (err) {
      log.error({ err }, "embedding worker batch error");
    }
    if (!stopped) timer = setTimeout(tick, processed === BATCH ? BUSY_MS : IDLE_MS);
  };

  log.info("embedding worker started");
  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
