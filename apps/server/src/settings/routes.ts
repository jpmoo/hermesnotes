import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { blockEmbeddings, blocks, userSettings } from "@hermes/db";
import { EMBEDDING_INDEX_DIM } from "@hermes/db/schema";
import { db } from "../db.js";
import { badRequest, notFound } from "../lib/errors.js";
import { authenticate, requireUser } from "../auth/middleware.js";
import { listModels, probeDimension } from "../ollama/client.js";

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  app.get("/settings", async (req) => {
    const userId = requireUser(req);
    const [row] = await db
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, userId))
      .limit(1);
    if (!row) throw notFound("settings");
    return {
      ollamaUrl: row.ollamaUrl,
      embedModel: row.embedModel,
      embedDim: row.embedDim,
      inferenceModel: row.inferenceModel,
      defaultSimilarity: row.defaultSimilarity,
      timezone: row.timezone,
      connected: Boolean(row.ollamaUrl && row.embedModel),
    };
  });

  /** UI preferences (nav row colors, etc.) — a free-form jsonb bag that syncs across devices. */
  app.get("/settings/preferences", async (req) => {
    const userId = requireUser(req);
    const [row] = await db
      .select({ preferences: userSettings.preferences })
      .from(userSettings)
      .where(eq(userSettings.userId, userId))
      .limit(1);
    return { preferences: row?.preferences ?? {} };
  });

  /** Shallow-merge a patch into the stored UI preferences. */
  app.patch("/settings/preferences", async (req) => {
    const userId = requireUser(req);
    const patch = z.record(z.unknown()).parse(req.body ?? {});
    const [current] = await db
      .select({ preferences: userSettings.preferences })
      .from(userSettings)
      .where(eq(userSettings.userId, userId))
      .limit(1);
    if (!current) throw notFound("settings");
    const next = { ...(current.preferences ?? {}), ...patch };
    await db
      .update(userSettings)
      .set({ preferences: next, updatedAt: new Date() })
      .where(eq(userSettings.userId, userId));
    return { preferences: next };
  });

  /**
   * Connect: list the models installed on an Ollama host. Accepts an explicit
   * url (to test before saving) or falls back to the stored one.
   */
  app.post("/settings/ollama/models", async (req) => {
    const userId = requireUser(req);
    const parsed = z.object({ ollamaUrl: z.string().url().optional() }).parse(req.body ?? {});
    let url = parsed.ollamaUrl;
    if (!url) {
      const [row] = await db
        .select({ ollamaUrl: userSettings.ollamaUrl })
        .from(userSettings)
        .where(eq(userSettings.userId, userId))
        .limit(1);
      url = row?.ollamaUrl ?? undefined;
    }
    if (!url) throw badRequest("no Ollama URL provided or stored");
    const models = await listModels(url);
    return { url, models };
  });

  /**
   * Save settings. Changing the embed model re-probes its dimension and triggers
   * a full re-embed for this user (clear vectors + mark blocks stale). The
   * embedding worker refills them under the new model.
   */
  app.put("/settings", async (req) => {
    const userId = requireUser(req);
    const body = z
      .object({
        ollamaUrl: z.string().url().nullable().optional(),
        embedModel: z.string().nullable().optional(),
        inferenceModel: z.string().nullable().optional(),
        defaultSimilarity: z.number().min(0).max(1).optional(),
        timezone: z.string().nullable().optional(),
      })
      .parse(req.body);

    const [current] = await db
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, userId))
      .limit(1);
    if (!current) throw notFound("settings");

    const nextUrl = body.ollamaUrl !== undefined ? body.ollamaUrl : current.ollamaUrl;
    const nextEmbed = body.embedModel !== undefined ? body.embedModel : current.embedModel;
    const embedChanged = nextEmbed !== current.embedModel;

    let embedDim = current.embedDim;
    if (embedChanged && nextEmbed) {
      if (!nextUrl) throw badRequest("cannot set an embed model without an Ollama URL");
      embedDim = await probeDimension(nextUrl, nextEmbed);
      if (embedDim > EMBEDDING_INDEX_DIM) {
        throw badRequest(
          `model '${nextEmbed}' produces ${embedDim}-dim vectors, which exceeds the ` +
            `index width ${EMBEDDING_INDEX_DIM}. Choose a smaller model or raise EMBEDDING_INDEX_DIM.`,
        );
      }
    } else if (embedChanged && !nextEmbed) {
      embedDim = null;
    }

    await db.transaction(async (tx) => {
      await tx
        .update(userSettings)
        .set({
          ollamaUrl: nextUrl,
          embedModel: nextEmbed,
          embedDim,
          inferenceModel:
            body.inferenceModel !== undefined ? body.inferenceModel : current.inferenceModel,
          defaultSimilarity:
            body.defaultSimilarity !== undefined ? body.defaultSimilarity : current.defaultSimilarity,
          timezone: body.timezone !== undefined ? body.timezone : current.timezone,
          updatedAt: new Date(),
        })
        .where(eq(userSettings.userId, userId));

      if (embedChanged) {
        // Old vectors were produced by a different model — discard and re-embed.
        await tx.delete(blockEmbeddings).where(eq(blockEmbeddings.ownerId, userId));
        await tx
          .update(blocks)
          .set({ embedSourceHash: null, embeddedAt: null })
          .where(eq(blocks.ownerId, userId));
      }
    });

    return {
      ollamaUrl: nextUrl,
      embedModel: nextEmbed,
      embedDim,
      inferenceModel:
        body.inferenceModel !== undefined ? body.inferenceModel : current.inferenceModel,
      defaultSimilarity:
        body.defaultSimilarity !== undefined ? body.defaultSimilarity : current.defaultSimilarity,
      timezone: body.timezone !== undefined ? body.timezone : current.timezone,
      connected: Boolean(nextUrl && nextEmbed),
      reembedTriggered: embedChanged,
    };
  });
}
