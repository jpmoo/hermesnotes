import { EventEmitter } from "node:events";

/**
 * In-process fan-out of block-change events to a user's live SSE connections.
 * Single-process deploy, so a plain EventEmitter is enough — no external broker.
 *
 * Events come from the change log (see events/watcher.ts), which reads what the
 * database recorded rather than what the request looked like. That's why there's
 * no origin here: the log knows a block changed, not which tab asked for it. A
 * tab tells its own echo apart by the version instead — it knows what it last
 * wrote, and news is anything newer than that.
 */
export interface ChangeEvent {
  kind: "block" | "delete";
  /** The affected block. */
  id: string;
  /** The block's version after the write. Absent on a delete, and on a change
   *  to a membership or tag — neither of which touches the block's own row, so
   *  neither has a version to report. */
  version?: number | null;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(0); // one listener per open SSE connection; can be many

const channel = (userId: string) => `u:${userId}`;

export function publishChange(userId: string, ev: ChangeEvent): void {
  emitter.emit(channel(userId), ev);
}

/** Subscribe a user's connection; returns an unsubscribe function. */
export function subscribeChanges(userId: string, cb: (ev: ChangeEvent) => void): () => void {
  const ch = channel(userId);
  emitter.on(ch, cb);
  return () => emitter.off(ch, cb);
}
