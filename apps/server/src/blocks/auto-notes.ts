import { sql } from "drizzle-orm";
import { PERIODIC_MARKERS } from "@hermes/shared";
import { db } from "../db.js";

/**
 * Daily scratchpads and weekly reflections are created on demand — opening a day
 * or an open review brings its note into being whether or not anything is ever
 * typed into it. Left alone, simply browsing accumulates empty notes.
 *
 * This deletes those never-written-in notes. Untouched rather than empty: a note
 * that opened with text carried forward from the last one, or with a template in
 * it, has content from its first moment — so what it was given is recorded when
 * it's made, and a note still holding exactly that has had nothing said in it.
 * An emptied one counts too: clearing a note is how you say you don't want it.
 *
 * The other guards are deliberately strict, because "empty content" alone
 * doesn't mean "empty note": a day with no text can still carry a banner or a
 * customised layout, and either is worth keeping. Only a note nobody wrote in
 * AND with nothing else hanging off it goes.
 *
 * `keepId` spares the note currently being viewed, which is legitimately empty
 * until its first keystroke. Notes minted in the last few minutes are spared too:
 * a second tab opening a different day sweeps on its own behalf and only spares
 * ITS note, which would otherwise pull the first tab's note out from under it.
 */
export async function purgeEmptyAutoNotes(userId: string, keepId?: string | null): Promise<void> {
  // Built from the shared list, so a new kind of periodic note is swept without
  // touching this query. Markers are our own identifiers, not user input.
  const markerTest = sql.join(
    PERIODIC_MARKERS.map((m) => sql`jsonb_exists(b.properties, ${m})`),
    sql` OR `,
  );
  await db.execute(sql`
    DELETE FROM blocks b
     WHERE b.owner_id = ${userId}::uuid
       AND b.archived_at IS NULL
       AND b.created_at < now() - interval '10 minutes'
       AND (
         COALESCE(b.content, '') = ''
         OR regexp_replace(COALESCE(b.content, ''), '\\s+$', '') = regexp_replace(COALESCE(b.properties->>'seed', ''), '\\s+$', '')
       )
       AND (${markerTest})
       AND NOT jsonb_exists(b.properties, 'banner')
       AND NOT jsonb_exists(b.properties, 'layout')
       AND (${keepId ?? null}::uuid IS NULL OR b.id <> ${keepId ?? null}::uuid)
       AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.block_id = b.id)
       AND NOT EXISTS (SELECT 1 FROM block_tags t WHERE t.block_id = b.id)
       AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.block_id = b.id)
  `);
}
