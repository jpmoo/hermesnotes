import { useEffect, useRef } from "react";
import { api, type Block } from "../api.ts";

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

export function emitBlockChange(blockId: string, origin: string): void {
  for (const l of [...listeners]) l(blockId, origin);
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
