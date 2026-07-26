import { useEffect, useRef } from "react";

/**
 * Tiny broadcast so a calendar-feed event converted from the info panel is
 * dropped from the calendar view right away (rather than waiting for the next
 * range change). Also carries the converted (feedId, uid) so a view can filter
 * it optimistically before its refetch lands.
 */
type Listener = (feedId: string, uid: string) => void;
const listeners = new Set<Listener>();

export function emitFeedEventConverted(feedId: string, uid: string): void {
  for (const l of [...listeners]) l(feedId, uid);
}

export function useFeedEventConverted(cb: (feedId: string, uid: string) => void): void {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    const l: Listener = (f, u) => ref.current(f, u);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
}
