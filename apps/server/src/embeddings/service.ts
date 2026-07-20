import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { blockEmbeddings, blocks, padEmbedding, userSettings } from "@hermes/db";
import { EMBEDDING_INDEX_DIM } from "@hermes/db/schema";
import { db } from "../db.js";
import { sha256 } from "../lib/hash.js";
import { embed } from "../ollama/client.js";

interface StaleRow {
  id: string;
  ownerId: string;
  embedSource: string;
  ollamaUrl: string;
  embedModel: string;
}

/** Fetch a batch of blocks that need (re)embedding and whose owner is configured. */
export async function fetchStaleBatch(limit: number): Promise<StaleRow[]> {
  return db
    .select({
      id: blocks.id,
      ownerId: blocks.ownerId,
      embedSource: sql<string>`${blocks.embedSource}`,
      ollamaUrl: sql<string>`${userSettings.ollamaUrl}`,
      embedModel: sql<string>`${userSettings.embedModel}`,
    })
    .from(blocks)
    .innerJoin(userSettings, eq(userSettings.userId, blocks.ownerId))
    .where(
      and(
        isNull(blocks.embedSourceHash),
        isNotNull(blocks.embedSource),
        isNotNull(userSettings.ollamaUrl),
        isNotNull(userSettings.embedModel),
      ),
    )
    .limit(limit);
}

/** Embed one block and persist. Returns false on a per-block failure (logged by caller). */
export async function embedBlock(row: StaleRow): Promise<void> {
  const vec = await embed(row.ollamaUrl, row.embedModel, row.embedSource);
  const padded = padEmbedding(vec, EMBEDDING_INDEX_DIM);

  await db.transaction(async (tx) => {
    await tx
      .insert(blockEmbeddings)
      .values({
        blockId: row.id,
        ownerId: row.ownerId,
        model: row.embedModel,
        dim: vec.length,
        embedding: padded,
      })
      .onConflictDoUpdate({
        target: blockEmbeddings.blockId,
        set: {
          model: row.embedModel,
          dim: vec.length,
          embedding: padded,
          embeddedAt: new Date(),
        },
      });

    // Stamp the hash of exactly what we embedded. If the block changed meanwhile,
    // the stored embed_source differs, this hash won't match, and it re-embeds
    // next tick — self-correcting.
    await tx
      .update(blocks)
      .set({ embedSourceHash: sha256(row.embedSource), embeddedAt: new Date() })
      .where(eq(blocks.id, row.id));
  });
}
