import { useEffect, useSyncExternalStore } from "react";

/**
 * Tracks which blocks currently have a live (editable) editor mounted in the
 * main viewport — a list card, a collection item, a scratchpad, etc. The info
 * panel reads this to avoid presenting a SECOND live editor for the same block
 * (two editors of one block fight over versions and remount each other on every
 * save). When a block is already editable in the viewport, the panel shows a
 * read-only preview instead.
 */
const counts = new Map<string, number>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) l();
}

function acquire(id: string): () => void {
  counts.set(id, (counts.get(id) ?? 0) + 1);
  emit();
  return () => {
    const n = (counts.get(id) ?? 1) - 1;
    if (n <= 0) counts.delete(id);
    else counts.set(id, n);
    emit();
  };
}

/** Register a viewport editor for `id` while mounted (no-op when `enabled` is
 *  false — e.g. the info panel's own editor, which must not register itself). */
export function useRegisterEditor(id: string, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    return acquire(id);
  }, [id, enabled]);
}

/** Whether some viewport editor is currently mounted for `id`. */
export function useEditorMounted(id: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => (counts.get(id) ?? 0) > 0,
  );
}
