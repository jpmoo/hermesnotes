import { useEffect, useRef } from "react";
import { api, apiBase, type Block } from "../api.ts";

/**
 * App-wide block-change bus: every editing surface (page card, info-panel
 * editor, list row, table row, canvas node) announces its saves and refreshes
 * itself when any OTHER surface saves the same block — so the viewport and the
 * info block always mirror each other, in both directions.
 *
 * Origin tokens keep an editor from clobbering itself: events carry the
 * emitting instance's id, and instances ignore their own echoes. Events that
 * arrive from the server carry no origin — the change log records that a block
 * changed, not which tab caused it — so a surface holding the block compares
 * versions instead, which also catches a stale repeat the origin never would.
 */

type Listener = (blockId: string, origin: string, version?: number | null) => void;
const listeners = new Set<Listener>();
type DeleteListener = (blockId: string) => void;
const deleteListeners = new Set<DeleteListener>();

export function emitBlockChange(blockId: string, origin: string, version?: number | null): void {
  for (const l of [...listeners]) l(blockId, origin, version);
}

/**
 * A block left every normal view — archived, or permanently deleted. Surfaces
 * holding it drop it immediately.
 *
 * This also fires the ordinary change listeners, because a block leaving is a
 * change to anything whose contents are computed: a smart list, a matrix, a
 * calendar. Without it those surfaces kept showing an archived card until
 * something else happened to make them re-run.
 */
export function emitBlockDeleted(blockId: string): void {
  for (const l of [...deleteListeners]) l(blockId);
  for (const l of [...listeners]) l(blockId, "deleted");
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
      let ev: { kind: "block" | "delete"; id: string; version?: number | null };
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }
      if (ev.kind === "delete") emitBlockDeleted(ev.id);
      // Everything the database recorded arrives here, this tab's own writes
      // included — the log knows a block changed, not who asked. A surface
      // holding the block tells its own echo apart by the version (see
      // useBlockSync); list-level `useAnyBlockChange` wants waking either way.
      else emitBlockChange(ev.id, "remote", ev.version);
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
 *
 * `shouldHold` guards live editing: if it returns true when a change arrives
 * (the surface is focused or has unsaved edits), the fresh block is stashed
 * instead of applied — so a remote edit never yanks the editor mid-keystroke.
 * Call the returned `release()` when the surface goes idle (on blur, after a
 * save settles) to apply the latest stashed block.
 */
export function useBlockSync(
  blockId: string,
  origin: string,
  apply: (b: Block) => void,
  shouldHold?: () => boolean,
  /**
   * The version this surface is holding. Server events carry no origin — the
   * change log records that a block changed, not who asked — so an echo of this
   * surface's own save is told apart by its version instead: anything at or
   * below what's already held is news to nobody, and refetching it would be a
   * round trip to be told what we just said.
   *
   * Omit it and every event is taken at face value, which is only wasteful.
   */
  heldVersion?: () => number | undefined,
): () => void {
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const holdRef = useRef(shouldHold);
  holdRef.current = shouldHold;
  const versionRef = useRef(heldVersion);
  versionRef.current = heldVersion;
  const deferred = useRef<Block | null>(null);
  useEffect(() => {
    const l: Listener = (id, src, version) => {
      if (id !== blockId || src === origin) return;
      // Null version: a membership or tag changed, or the block went — neither
      // reports one, and both are worth hearing about.
      const held = versionRef.current?.();
      if (version != null && held != null && version <= held) return;
      void api
        .get<Block>(`/blocks/${blockId}`)
        .then((b) => {
          if (holdRef.current?.()) deferred.current = b;
          else applyRef.current(b);
        })
        .catch(() => {});
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, [blockId, origin]);
  // Stable release: apply the newest stashed block, if any.
  const release = useRef(() => {
    if (deferred.current) {
      const b = deferred.current;
      deferred.current = null;
      applyRef.current(b);
    }
  });
  return release.current;
}
