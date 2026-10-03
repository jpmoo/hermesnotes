import { and, asc, eq } from "drizzle-orm";
import { assistantThreads } from "@hermes/db";
import { db } from "../db.js";

/**
 * Conversations that live on a canvas — see migration 0034.
 *
 * Every read and write here is scoped to the user as well as the id: a thread
 * id is a uuid that travels through the browser, and one person's discussion
 * must not be readable, renamed or deleted by naming its id from another
 * account.
 */

export interface Thread {
  id: string;
  collectionId: string | null;
  anchorId: string | null;
  noteId: string | null;
  title: string;
}

const columns = {
  id: assistantThreads.id,
  collectionId: assistantThreads.collectionId,
  anchorId: assistantThreads.anchorId,
  noteId: assistantThreads.noteId,
  title: assistantThreads.title,
};

/**
 * A new discussion. The id may come from the canvas, which draws the bubble —
 * carrying that id — before this row exists; a uuid the client chose is as
 * good as one Postgres chose, and a clash is a primary-key error, not a merge.
 */
export async function createThread(
  userId: string,
  t: { id?: string; collectionId: string; anchorId: string; noteId: string; title?: string },
): Promise<Thread> {
  const [row] = await db
    .insert(assistantThreads)
    .values({
      ...(t.id ? { id: t.id } : {}),
      userId,
      collectionId: t.collectionId,
      anchorId: t.anchorId,
      noteId: t.noteId,
      title: t.title ?? "",
    })
    .returning(columns);
  return row!;
}

export async function getThread(userId: string, id: string): Promise<Thread | null> {
  const [row] = await db
    .select(columns)
    .from(assistantThreads)
    .where(and(eq(assistantThreads.userId, userId), eq(assistantThreads.id, id)))
    .limit(1);
  return row ?? null;
}

export async function threadsOn(userId: string, collectionId: string): Promise<Thread[]> {
  return db
    .select(columns)
    .from(assistantThreads)
    .where(and(eq(assistantThreads.userId, userId), eq(assistantThreads.collectionId, collectionId)))
    .orderBy(asc(assistantThreads.createdAt));
}

export async function renameThread(userId: string, id: string, title: string): Promise<void> {
  await db
    .update(assistantThreads)
    .set({ title, updatedAt: new Date() })
    .where(and(eq(assistantThreads.userId, userId), eq(assistantThreads.id, id)));
}

/** Its messages go with it — `ON DELETE CASCADE` on assistant_messages. */
export async function deleteThread(userId: string, id: string): Promise<void> {
  await db
    .delete(assistantThreads)
    .where(and(eq(assistantThreads.userId, userId), eq(assistantThreads.id, id)));
}
