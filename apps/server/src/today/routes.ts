import { and, desc, eq, gte, lt, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { normalizeTodayLayout, todayLayoutSchema, type PropertySchema } from "@hermes/shared";
import { blocks, blockTypes, userSettings } from "@hermes/db";
import { db } from "../db.js";
import { badRequest } from "../lib/errors.js";
import { zonedDayRange } from "../lib/timezone.js";
import { authenticate, requireUser } from "../auth/middleware.js";

/** Find (or lazily create) the hidden scratchpad note for a date. */
async function findOrCreateNote(userId: string, date: string) {
  const [existing] = await db
    .select(blockView)
    .from(blocks)
    .where(and(eq(blocks.ownerId, userId), sql`${blocks.properties}->>'today_note' = ${date}`))
    .limit(1);
  if (existing) return existing;
  // Look up by the isText flag, not the (user-renameable) type name.
  const [textType] = await db
    .select({ id: blockTypes.id, schemaVersion: blockTypes.schemaVersion })
    .from(blockTypes)
    .where(and(eq(blockTypes.ownerId, userId), eq(blockTypes.isText, true)))
    .orderBy(desc(blockTypes.builtin))
    .limit(1);
  if (!textType) throw badRequest("text block type missing");
  const [created] = await db
    .insert(blocks)
    .values({
      ownerId: userId,
      blockTypeId: textType.id,
      content: "",
      properties: { today_note: date },
      embedSource: "",
      embedSourceHash: null,
      blockTypeSchemaVersion: textType.schemaVersion,
    })
    .returning(blockView);
  return created!;
}

const blockView = {
  id: blocks.id,
  blockTypeId: blocks.blockTypeId,
  collectionKind: blocks.collectionKind,
  content: blocks.content,
  properties: blocks.properties,
  embeddedAt: blocks.embeddedAt,
  embedPending: sql<boolean>`(${blocks.embedSourceHash} IS NULL AND ${blocks.embedSource} IS NOT NULL)`,
  version: blocks.version,
  createdAt: blocks.createdAt,
  updatedAt: blocks.updatedAt,
};

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Date portion of a "YYYY-MM-DD[THH:mm]" value, or null. */
function dateOf(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  const d = v.split("T")[0];
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

/**
 * A block is "relevant" to a date if any datetime/date property lands on it, or
 * the date falls within any datespan property (inclusive of start/end, ignoring
 * time).
 */
function isRelevant(
  schema: PropertySchema | null,
  props: Record<string, unknown>,
  date: string,
): boolean {
  if (!schema) return false;
  for (const f of schema.fields) {
    if (f.type === "datetime" || f.type === "date") {
      if (dateOf(props[f.key]) === date) return true;
    } else if (f.type === "datespan") {
      const span = props[f.key] as { start?: unknown; end?: unknown } | undefined;
      if (span && typeof span === "object") {
        const s = dateOf(span.start);
        const e = dateOf(span.end);
        if (s && s === date) return true;
        if (e && e === date) return true;
        if (s && e && s <= date && date <= e) return true;
      }
    }
  }
  return false;
}

export async function todayRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  /** Dates that have a non-empty scratchpad note (for the calendar). */
  app.get("/today/dates", async (req) => {
    const userId = requireUser(req);
    const rows = await db
      .select({ d: sql<string>`${blocks.properties}->>'today_note'` })
      .from(blocks)
      .where(
        and(
          eq(blocks.ownerId, userId),
          sql`jsonb_exists(${blocks.properties}, 'today_note')`,
          sql`COALESCE(${blocks.content}, '') <> ''`,
        ),
      );
    return [...new Set(rows.map((r) => r.d).filter(Boolean))];
  });

  /** The Today sheet for a date: scratchpad note + relevant + activity blocks. */
  app.get("/today/:date", async (req) => {
    const userId = requireUser(req);
    const { date } = z.object({ date: DATE }).parse(req.params);

    const note = await findOrCreateNote(userId, date);

    // Activity: blocks created or edited on this date, in the user's timezone.
    const [tzRow] = await db
      .select({ tz: userSettings.timezone })
      .from(userSettings)
      .where(eq(userSettings.userId, userId))
      .limit(1);
    const { start, end } = zonedDayRange(date, tzRow?.tz ?? null);
    const activity = await db
      .select(blockView)
      .from(blocks)
      .where(
        and(
          eq(blocks.ownerId, userId),
          sql`${blocks.collectionKind} IS NULL`,
          sql`NOT jsonb_exists(${blocks.properties}, 'today_note')`,
          or(
            and(gte(blocks.createdAt, start), lt(blocks.createdAt, end)),
            and(gte(blocks.updatedAt, start), lt(blocks.updatedAt, end)),
          ),
        ),
      )
      .orderBy(sql`${blocks.updatedAt} DESC`)
      .limit(500);

    // Relevant: schema-aware, filtered in JS over candidate blocks.
    const types = await db
      .select({ id: blockTypes.id, schema: blockTypes.propertySchema })
      .from(blockTypes)
      .where(eq(blockTypes.ownerId, userId));
    const schemaById = new Map(types.map((t) => [t.id, t.schema]));
    const candidates = await db
      .select(blockView)
      .from(blocks)
      .where(
        and(
          eq(blocks.ownerId, userId),
          sql`${blocks.collectionKind} IS NULL`,
          sql`NOT jsonb_exists(${blocks.properties}, 'today_note')`,
        ),
      )
      .limit(2000);
    const relevant = candidates.filter((b) =>
      isRelevant(
        b.blockTypeId ? schemaById.get(b.blockTypeId) ?? null : null,
        b.properties as Record<string, unknown>,
        date,
      ),
    );

    const layout = normalizeTodayLayout((note.properties as Record<string, unknown>).layout);
    return { note, relevant, activity, layout };
  });

  /** Persist the ordered section layout for a date's Today sheet. */
  app.put("/today/:date/layout", async (req) => {
    const userId = requireUser(req);
    const { date } = z.object({ date: DATE }).parse(req.params);
    const { layout } = z.object({ layout: todayLayoutSchema }).parse(req.body);
    const note = await findOrCreateNote(userId, date);
    const normalized = normalizeTodayLayout(layout);
    const nextProps = { ...(note.properties as Record<string, unknown>), layout: normalized };
    await db
      .update(blocks)
      .set({ properties: nextProps, version: sql`${blocks.version} + 1`, updatedAt: new Date() })
      .where(and(eq(blocks.id, note.id), eq(blocks.ownerId, userId)));
    return { layout: normalized };
  });
}
