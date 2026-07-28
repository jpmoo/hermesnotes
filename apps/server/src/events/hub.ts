import { EventEmitter } from "node:events";

/**
 * In-process fan-out of block-change events to a user's live SSE connections.
 * Single-process deploy, so a plain EventEmitter is enough — no external broker.
 * `origin` is the client-id of the tab that caused the change (from the request
 * header), so a tab can ignore the echo of its own edit.
 */
export interface ChangeEvent {
  kind: "block" | "delete";
  /** The affected block id; empty string means "something changed, re-query
   * lists" (e.g. a create, whose id isn't in the request URL). */
  id: string;
  origin?: string;
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
