import { isComplete, type PropertySchema } from "@hermes/shared";
import type { HermesTypeRow } from "@talaria/canonical";
import { HermesError, OfflineError, type Hermes, type SyncBlockRow } from "./hermes.js";
import type { Mirror, QueuedIntent } from "./mirror.js";

/**
 * Writes made while Hermes was out of reach.
 *
 * The queue holds **what the user meant**, never the document that would
 * result. `PATCH /blocks/:id` replaces `properties` wholesale, so a payload
 * stored three hours ago and replayed now is a whole-object replacement of
 * state it has never seen; version checking keeps that safe, but safe-and-
 * rejected is its own failure — "I marked it done on the plane and it didn't
 * take" costs the same trust as a stale read.
 *
 * Re-applying an intent against current state means most apparent conflicts
 * were never conflicts at all: two writes touching different fields of the same
 * block. What's left — the genuine disagreements — is parked for a person,
 * never guessed at.
 */

export interface CreateIntent {
  kind: "create";
  /** Minted locally, so the block has an identity before it has ever synced. */
  id: string;
  blockTypeId?: string;
  content?: string;
  properties?: Record<string, unknown>;
}
export interface CompleteIntent {
  kind: "complete";
  blockId: string;
  /** The status value to set, resolved when the intent was made. */
  status: string;
}
export interface AppendIntent {
  kind: "append";
  date: string;
  text: string;
}
export interface MoveIntent {
  kind: "move";
  collectionId: string;
  blockId: string;
  /** The cell it was dragged into. */
  region: number;
}
export type Intent = CreateIntent | CompleteIntent | AppendIntent | MoveIntent;

export type ReplayResult =
  | { id: number; outcome: "applied" | "already" }
  | { id: number; outcome: "parked"; reason: string }
  | { id: number; outcome: "deferred"; reason: string };

/** The same joining rule the app uses, so a queued append reads like a typed one. */
export function appendedContent(before: string | null, addition: string): string {
  const head = (before ?? "").replace(/\s+$/, "");
  const tail = addition.trim();
  return head ? `${head}\n\n${tail}\n` : `${tail}\n`;
}

export class Queue {
  constructor(
    private hermes: Hermes,
    private mirror: Mirror,
  ) {}

  add(intent: Intent, baseVersion: number | null): number {
    return this.mirror.enqueue(intent.kind, intent, baseVersion);
  }

  list(): { row: QueuedIntent; intent: Intent }[] {
    return this.mirror.pending().map((row) => ({ row, intent: JSON.parse(row.payload) as Intent }));
  }

  private schemaFor(typeId: string | null): PropertySchema | null {
    if (!typeId) return null;
    for (const raw of this.mirror.types()) {
      const t = JSON.parse(raw) as HermesTypeRow;
      if (t.id === typeId) return t.propertySchema;
    }
    return null;
  }

  /**
   * Push everything pending. Stops at the first sign the network has gone
   * again, because the rest would only fail the same way — and a queue drained
   * into a dead link would burn its attempt counts for nothing.
   */
  async drain(): Promise<ReplayResult[]> {
    const out: ReplayResult[] = [];
    for (const { row, intent } of this.list()) {
      if (row.parkedReason) continue; // waiting on a person, not on us
      let result: ReplayResult;
      try {
        result = await this.replay(row, intent);
      } catch (err) {
        if (err instanceof OfflineError) {
          out.push({ id: row.id, outcome: "deferred", reason: "offline" });
          break;
        }
        this.mirror.park(row.id, (err as Error).message);
        out.push({ id: row.id, outcome: "parked", reason: (err as Error).message });
        continue;
      }
      if (result.outcome === "applied" || result.outcome === "already") this.mirror.dequeue(row.id);
      if (result.outcome === "parked") this.mirror.park(row.id, result.reason);
      out.push(result);
      if (result.outcome === "deferred") break;
    }
    return out;
  }

  private async replay(row: QueuedIntent, intent: Intent): Promise<ReplayResult> {
    switch (intent.kind) {
      case "create":
        return this.replayCreate(row, intent);
      case "complete":
        return this.replayComplete(row, intent);
      case "append":
        return this.replayAppend(row, intent);
      case "move":
        return this.replayMove(row, intent);
    }
  }

  /**
   * Idempotent by construction: the id was decided locally, so a repeat of this
   * create is recognisably the same create and the server hands back what it
   * already has rather than making a second one.
   */
  private async replayCreate(row: QueuedIntent, intent: CreateIntent): Promise<ReplayResult> {
    const created = await this.hermes.createBlock({
      id: intent.id,
      blockTypeId: intent.blockTypeId,
      content: intent.content,
      properties: intent.properties,
    });
    // The block is already in the mirror — it was written there when the intent
    // was made, which is what gave it an identity to be found by before it had
    // ever reached a server. Version 1 means this call is what created it;
    // anything higher means a previous attempt did, and was edited since.
    return { id: row.id, outcome: created.version === 1 ? "applied" : "already" };
  }

  private async replayComplete(row: QueuedIntent, intent: CompleteIntent): Promise<ReplayResult> {
    let current: SyncBlockRow | undefined;
    try {
      const page = await this.hermes.blocksByIds([intent.blockId]);
      current = page.blocks[0];
    } catch (err) {
      if (err instanceof HermesError && err.status === 404) current = undefined;
      else throw err;
    }
    if (!current) {
      return { id: row.id, outcome: "parked", reason: "that block no longer exists" };
    }
    if (current.archivedAt) {
      // Never resurrect something the user filed away while we were out of
      // touch; they had newer information than the queue does.
      return { id: row.id, outcome: "parked", reason: "the block was archived meanwhile" };
    }
    const schema = this.schemaFor(current.blockTypeId);
    if (!schema?.status_field) {
      return { id: row.id, outcome: "parked", reason: "that block has no status to set" };
    }
    if (isComplete(schema, current.properties)) {
      // Ticked in the app too. Nothing to do, and nothing worth saying.
      return { id: row.id, outcome: "already" };
    }
    await this.hermes.patchBlock(intent.blockId, {
      version: current.version,
      properties: { ...current.properties, [schema.status_field]: intent.status },
    });
    return { id: row.id, outcome: "applied" };
  }

  /**
   * Where a card sits is a single value, so a replayed move is simply the last
   * word on it. No merge to do and nothing to conflict with — except the card
   * having left the collection entirely, which is a person's business.
   */
  private async replayMove(row: QueuedIntent, intent: MoveIntent): Promise<ReplayResult> {
    try {
      await this.hermes.placeMember(intent.collectionId, intent.blockId, { region: intent.region });
      return { id: row.id, outcome: "applied" };
    } catch (err) {
      if (err instanceof HermesError && (err.status === 404 || err.status === 400)) {
        return { id: row.id, outcome: "parked", reason: "that card is no longer in this collection" };
      }
      throw err;
    }
  }

  /**
   * Appends are near-commutative: two of them in either order give a different
   * document, not a wrong one. So this re-reads the note and appends to its
   * *current* end rather than replaying a body computed while offline.
   */
  private async replayAppend(row: QueuedIntent, intent: AppendIntent): Promise<ReplayResult> {
    const note = await this.hermes.dailyNote(intent.date);
    const existing = note.content ?? "";
    // A lost response has no id to recognise itself by, so the text itself is
    // the evidence. Fails toward not duplicating, which is the right direction:
    // a line the user has to add again is a smaller injury than one that
    // silently appears twice.
    if (existing.trimEnd().endsWith(intent.text.trim())) {
      return { id: row.id, outcome: "already" };
    }
    await this.hermes.patchBlock(note.id, {
      version: note.version,
      content: appendedContent(existing, intent.text),
    });
    return { id: row.id, outcome: "applied" };
  }
}
