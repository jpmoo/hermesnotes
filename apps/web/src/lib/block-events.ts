import { useEffect, useRef } from "react";
import { api, apiBase, CLIENT_ID, type Block } from "../api.ts";

/**
 * App-wide block-change bus: every editing surface (page card, info-panel
 * editor, list row, table row, canvas node) announces its saves and refreshes
 * itself when any OTHER surface saves the same block — so the viewport and the
 * info block always mirror each other, in both directions.
 *
 * Origin tokens keep an editor from clobbering itself: events carry the
 * emitting instance's id, and instances ignore their own echoes.
 */

type Listener = (blockId: string, origin: string) => void;
const listeners = new Set<Listener>();
type DeleteListener = (blockId: string) => void;
const deleteListeners = new Set<DeleteListener>();

export function emitBlockChange(blockId: string, origin: string): void {
  for (const l of [...listeners]) l(blockId, origin);
}

/** A block was permanently deleted — every surface drops it immediately. */
export function emitBlockDeleted(blockId: string): void {
  for (const l of [...deleteListeners]) l(blockId);
}

/**
 * Live sync: subscribe to the server's SSE stream and feed remote block changes
 * (another tab, another device, the AI over MCP) into the SAME in-tab bus, so
 * every surface that already reacts to local edits reacts to remote ones too.
 * A tab skips the echo of its own edits (matched by client id). Mount once, at
 * the app shell. EventSource auto-reconnects on drop.
 */
export function useLiveSync(): void {
  useEffect(() => {
    const es = new EventSource(`${apiBase}/events`, { withCredentials: true });
    es.onmessage = (e) => {
      let ev: { kind: "block" | "delete"; id: string; origin?: string };
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }
      if (ev.origin === CLIENT_ID) return; // our own change — already handled in-tab
      if (ev.kind === "delete") emitBlockDeleted(ev.id);
      // A remote origin, so no in-tab listener will double-fire; the empty id
      // (a create/membership change) still wakes list-level `useAnyBlockChange`.
      else emitBlockChange(ev.id, "remote");
    };
    return () => es.close();
  }, []);
}

export function useBlockDeleted(cb: (blockId: string) => void): void {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    const l: DeleteListener = (id) => ref.current(id);
    deleteListeners.add(l);
    return () => {
      deleteListeners.delete(l);
    };
  }, []);
}

/**
 * Fires on ANY change event for the block (own edits included) without
 * refetching — for surfaces that need to refresh derived data such as the
 * info pane's connections.
 */
export function useBlockChanged(blockId: string, cb: () => void): void {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    const l: Listener = (id) => {
      if (id === blockId) ref.current();
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, [blockId]);
}

/**
 * Fires whenever ANY block changes anywhere (own edits included) — for surfaces
 * whose membership can shift out from under them, e.g. a smart collection or
 * matrix that must re-run its query when a member is edited out of eligibility.
 */
export function useAnyBlockChange(cb: (blockId: string) => void): void {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    const l: Listener = (id) => ref.current(id);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
}

/** Unique origin token for one mounted editing surface. */
export function useBlockOrigin(): string {
  const ref = useRef<string>();
  if (!ref.current) ref.current = crypto.randomUUID();
  return ref.current;
}

/**
 * Refetch-and-apply when another surface changes this block. `apply` receives
 * the fresh block; the caller resets its local props/content/version from it.
 */
export function useBlockSync(
  blockId: string,
  origin: string,
  apply: (b: Block) => void,
): void {
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    const l: Listener = (id, src) => {
      if (id !== blockId || src === origin) return;
      void api
        .get<Block>(`/blocks/${blockId}`)
        .then((b) => applyRef.current(b))
        .catch(() => {});
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, [blockId, origin]);
}
