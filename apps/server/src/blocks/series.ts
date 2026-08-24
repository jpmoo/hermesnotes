import { blocks, series } from "@hermes/db";
import { recurrenceSchema, type PropertySchema } from "@hermes/shared";
import { and, eq } from "drizzle-orm";
import { db } from "../db.js";

/**
 * Keep a block's series in step with the rule written on it.
 *
 * The rule lives in two places during the move onto the series table, and two
 * places holding one fact will disagree the moment somebody edits one. Editing a
 * recurrence in the app writes the property; without this the series row would
 * still hold whatever it was backfilled with, and the export — the only thing
 * reading the series today — would quietly describe a rule the user changed
 * weeks ago.
 *
 * Also where a series is born. A task that gains a rule gets one immediately
 * rather than waiting until its first completion, so it is exportable as a
 * recurrence from the moment it becomes one.
 *
 * Returns the series id, which may be new.
 */
export async function syncSeries(
  userId: string,
  blockId: string,
  seriesId: string | null,
  schema: PropertySchema | null,
  props: Record<string, unknown>,
): Promise<string | null> {
  const recField = schema?.fields.find((f) => f.type === "recurrence");
  if (!recField) return seriesId;
  const parsed = recurrenceSchema.safeParse(props[recField.key]);
  if (!parsed.success) {
    // The rule is gone. The series stays: its instances are still real, and the
    // record of what governed them is worth more than the tidiness of removing
    // it. The link is what says this block no longer repeats.
    if (seriesId) await db.update(blocks).set({ seriesId: null }).where(eq(blocks.id, blockId));
    return null;
  }
  const { n: _n, ...rule } = parsed.data;
  if (seriesId) {
    await db.update(series).set({ rule }).where(and(eq(series.id, seriesId), eq(series.ownerId, userId)));
    return seriesId;
  }
  const [made] = await db.insert(series).values({ ownerId: userId, rule }).returning({ id: series.id });
  if (made) await db.update(blocks).set({ seriesId: made.id }).where(eq(blocks.id, blockId));
  return made?.id ?? null;
}
