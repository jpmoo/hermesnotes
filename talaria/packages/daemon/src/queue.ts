import { isComplete, type InterchangeObject, type InterchangeType } from "@talaria/canonical";
import { HermesError, OfflineError, type Hermes } from "./hermes.js";
import { regionNameAt, UnsupportedError, type Interchange } from "./interchange.js";
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
  /** The cell it was dragged into, or null for back into the drawer. */
  region: number | null;
  /** Whether this also joins the collection — see Hermes.placeMember. */
  join: boolean;
  /** Where it came from, so the region it left can undo what it did. */
  fromRegion: number | null;
}
export type Intent = CreateIntent | CompleteIntent | AppendIntent | MoveIntent;

export type ReplayResult =
  | { id: number; outcome: "applied" | "already" }
  | { id: number; outcome: "parked"; reason: string }
  | { id: number; outcome: "deferred"; reason: string };

/**
 * What a matrix region does to a card that arrives in it.
 *
 * A region can carry a tag and a status, and dropping a card into one is
 * supposed to apply them — that is what the region is *for*, and moving a task
 * into "Do" without it becoming #do makes the board a picture of an
 * arrangement rather than the arrangement itself. Talaria was setting the
 * placement and nothing else.
 *
 * The rules are the app's: tag on entry unless the region says otherwise,
 * remove the old region's tag only when it asked to be removed on leaving, and
 * set a status only when it is one the type actually offers.
 */
export async function applyRegionActions(
  ix: Interchange,
  hermes: Hermes,
  mirror: Mirror,
  intent: MoveIntent,
): Promise<void> {
  const raw = mirror.rawBlock(intent.collectionId);
  if (!raw) return;
  // What a region *does* to what lands in it lives on the declared placement
  // now, under the producer's own prefix. It used to be read off
  // `properties.matrix_regions`, which an export does not carry — so this had
  // been quietly doing nothing since Talaria moved onto the binding: cards
  // moved, boards recorded the arrangement, and none of the tagging that makes
  // the arrangement mean anything happened.
  const declared = ((JSON.parse(raw) as { placement?: { regions?: unknown[] } }).placement?.regions ??
    []) as (string | Record<string, unknown>)[];
  const at = (i: number | null): Record<string, unknown> | undefined => {
    if (i === null) return undefined;
    const r = declared[i];
    return typeof r === "object" && r !== null ? r : undefined;
  };
  const entering = at(intent.region);
  const leaving = at(intent.fromRegion);
  const key = (r: Record<string, unknown> | undefined, k: string) => r?.[`hermes:${k}`];

  const enterTag = key(entering, "tag");
  const leaveTag = key(leaving, "tag");
  const addTag =
    typeof enterTag === "string" && enterTag && key(entering, "tagOnEnter") !== false ? enterTag : null;
  const dropTag =
    typeof leaveTag === "string" && leaveTag && key(leaving, "tagOffLeave") === true ? leaveTag : null;

  if (addTag || dropTag) {
    try {
      // One named move through the binding. This used to be `GET` then `PUT
      // /blocks/:id/tags` — two round trips against private routes, doing a
      // read-modify-write because Hermes' own route takes the whole list and a
      // whole-list write would have deleted every tag Talaria had not heard of.
      // The merge lives in the producer now, where it only has to be right once.
      const raw = mirror.rawBlock(intent.blockId);
      const version = raw ? ((JSON.parse(raw) as InterchangeObject).version ?? 0) : 0;
      await ix.patch(intent.blockId, {
        ...(addTag ? { addTags: [addTag] } : {}),
        ...(dropTag ? { removeTags: [dropTag] } : {}),
        version,
      });
    } catch {
      // A tag that wouldn't apply shouldn't undo a move that already has.
    }
  }

  const enterStatus = key(entering, "enterStatus");
  const wantStatus = typeof enterStatus === "string" ? enterStatus : "";
  if (!wantStatus) return;
  const blockRaw = mirror.rawBlock(intent.blockId);
  if (!blockRaw) return;
  const block = JSON.parse(blockRaw) as InterchangeObject;
  const type = mirror
    .types()
    .map((t) => JSON.parse(t) as InterchangeType)
    .find((t) => t.id === block.type);
  const statusKey = type?.profiles?.task?.status;
  if (typeof statusKey !== "string") return;
  const field = (type?.fields ?? []).find((f) => f.key === statusKey);
  // Only if the type actually offers it: writing a value a status field has
  // never heard of leaves an object in a state nothing can read.
  const offers = (field?.options ?? []).some((o) => (typeof o === "string" ? o : o.value) === wantStatus);
  if (!offers) return;
  try {
    // Two keys, not the whole bag. Everything else on this object is untouched,
    // including the fields Talaria has never heard of.
    await ix.patch(intent.blockId, { set: { [statusKey]: wantStatus }, version: block.version ?? 0 });
  } catch {
    // Same reasoning: the placement stands.
  }
}

/** The same joining rule the app uses, so a queued append reads like a typed one. */
export function appendedContent(before: string | null, addition: string): string {
  const head = (before ?? "").replace(/\s+$/, "");
  const tail = addition.trim();
  return head ? `${head}\n\n${tail}\n` : `${tail}\n`;
}

export class Queue {
  constructor(
    private ix: Interchange,
    private hermes: Hermes,
    private mirror: Mirror,
  ) {}

  add(intent: Intent, baseVersion: number | null): number {
    return this.mirror.enqueue(intent.kind, intent, baseVersion);
  }

  list(): { row: QueuedIntent; intent: Intent }[] {
    return this.mirror.pending().map((row) => ({ row, intent: JSON.parse(row.payload) as Intent }));
  }

  /**
   * What a board calls the region at this index.
   *
   * The app still counts cells, because a grid is drawn left to right and a
   * person dragging a card is pointing at a square. The binding carries names,
   * because a square is a fact about this renderer. The translation is here, at
   * the boundary, and it is the only place either vocabulary meets the other.
   */
  private regionName(collectionId: string, index: number): string | null {
    const raw = this.mirror.rawBlock(collectionId);
    return raw ? regionNameAt(JSON.parse(raw), index) : null;
  }

  private typeFor(typeId: string | null): InterchangeType | undefined {
    if (!typeId) return undefined;
    for (const raw of this.mirror.types()) {
      const t = JSON.parse(raw) as InterchangeType;
      if (t.id === typeId) return t;
    }
    return undefined;
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
        // A verb this producer has not got. Waits rather than parking: parking
        // is for a decision somebody has to make, and "the server has not been
        // upgraded yet" is not one — it resolves on its own, and the write
        // should go out when it does rather than sit needing a hand.
        if (err instanceof UnsupportedError) {
          out.push({ id: row.id, outcome: "deferred", reason: err.message });
          continue;
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
   * create is recognizably the same create and the server hands back what it
   * already has rather than making a second one.
   */
  private async replayCreate(row: QueuedIntent, intent: CreateIntent): Promise<ReplayResult> {
    // Through the binding. This was `hermes.createBlock` — a Hermes route —
    // because the format had no verb for it, which LIMITS.md called the largest
    // remaining hole in the port. It now has one, and the port has no hole.
    const made = await this.ix.put(intent.id, {
      type: intent.blockTypeId,
      content: intent.content,
      properties: intent.properties,
    });
    // The block is already in the mirror — it was written there when the intent
    // was made, which is what gave it an identity to be found by before it had
    // ever reached a server. The producer says whether this call is what created
    // it; `created: false` means a previous attempt already did, and the answer
    // is the object as it stands rather than a second one.
    //
    // Asked rather than inferred from a version number, which is what this did
    // before: version 1 meant "we made it" and anything higher meant "somebody
    // had", which is the same question answered by proxy and wrong the moment a
    // producer numbers differently.
    return { id: row.id, outcome: made.created === false ? "already" : "applied" };
  }

  /**
   * Tick something off.
   *
   * Reads the object from the mirror rather than fetching it first. The binding
   * has no read-by-id and does not need one here: the version travels with
   * every object, so the mirror already holds the token this write has to
   * present, and a stale one is refused rather than merged. The refusal is the
   * answer — it means somebody else got there, which is a person's business and
   * not something to resolve by overwriting them.
   */
  private async replayComplete(row: QueuedIntent, intent: CompleteIntent): Promise<ReplayResult> {
    const raw = this.mirror.rawBlock(intent.blockId);
    if (!raw) return { id: row.id, outcome: "parked", reason: "that object is no longer here" };
    const current = JSON.parse(raw) as InterchangeObject;
    if (current.archived) {
      // Never resurrect something the user filed away while we were out of
      // touch; they had newer information than the queue does.
      return { id: row.id, outcome: "parked", reason: "the object was archived meanwhile" };
    }
    const type = this.typeFor(current.type ?? null);
    const statusKey = type?.profiles?.task?.status;
    if (typeof statusKey !== "string") {
      return { id: row.id, outcome: "parked", reason: "that type declares no task status" };
    }
    if (isComplete(type, current)) {
      // Ticked in the app too. Nothing to do, and nothing worth saying.
      return { id: row.id, outcome: "already" };
    }
    const answer = await this.ix.patch(intent.blockId, {
      set: { [statusKey]: intent.status },
      version: current.version ?? 0,
    });
    if (!answer.ok) {
      return {
        id: row.id,
        outcome: "parked",
        reason: answer.conflict ? "it changed while we were away" : "the write was refused",
      };
    }
    return { id: row.id, outcome: "applied" };
  }

  /**
   * Where a card sits is a single value, so a replayed move is simply the last
   * word on it. No merge to do and nothing to conflict with — except the card
   * having left the collection entirely, which is a person's business.
   */
  private async replayMove(row: QueuedIntent, intent: MoveIntent): Promise<ReplayResult> {
    try {
      // A region *name*, which is what the board publishes and what any other
      // tool would understand. Translating it back to whatever index this
      // producer stores is the producer's job, and a name it never declared is
      // refused rather than quietly filed somewhere nothing renders.
      const answer = await this.ix.place(
        intent.collectionId,
        intent.blockId,
        intent.region === null ? null : this.regionName(intent.collectionId, intent.region),
      );
      if (!answer.ok) {
        return { id: row.id, outcome: "parked", reason: "that region is not on this board" };
      }
      await applyRegionActions(this.ix, this.hermes, this.mirror, intent);
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
    // A lost response has no id to recognize itself by, so the text itself is
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
