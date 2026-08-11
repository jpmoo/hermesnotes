import { useRef, useState } from "react";

/**
 * Hover-intent: reveal after a short dwell, hide after a brief grace period —
 * so the auto-hiding panels don't flicker open when the cursor merely passes by.
 */
export function useHoverIntent(enterDelay = 320, leaveDelay = 220) {
  const [active, setActive] = useState(false);
  const enterTimer = useRef<ReturnType<typeof setTimeout>>();
  /** When the running dwell started and how long it's for, so a quicker one can
   *  overtake it and a slower one can't push it back. */
  const pending = useRef<{ at: number; delay: number } | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>();

  // Arm the reveal after a dwell. Callers can pass a delay to override the
  // default per-region (e.g. a longer dwell over clickable icons — where the
  // cursor is likely just passing to a click — and a shorter one over empty
  // rail space, where a hover almost always means "open me").
  const arm = (delay = enterDelay) => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    // A dwell already running is left alone unless the new one would open
    // sooner. Two things depend on this: mouseover fires again for every
    // descendant the pointer crosses (an icon, its glyph, its label), and
    // restarting each time meant the countdown never finished over a row of
    // icons; while moving from a slow region to a quick one — off an icon into
    // the gap beside it — should still speed the reveal up rather than serve
    // out the longer wait.
    if (enterTimer.current && pending.current) {
      const remaining = pending.current.at + pending.current.delay - Date.now();
      if (delay >= remaining) return;
      clearTimeout(enterTimer.current);
    }
    pending.current = { at: Date.now(), delay };
    enterTimer.current = setTimeout(() => {
      enterTimer.current = undefined;
      pending.current = null;
      setActive(true);
    }, delay);
  };
  const onMouseEnter = () => arm();
  const onMouseLeave = () => {
    if (enterTimer.current) clearTimeout(enterTimer.current);
    enterTimer.current = undefined;
    leaveTimer.current = setTimeout(() => setActive(false), leaveDelay);
  };
  // Cancel a pending open without collapsing (e.g. moving onto an icon).
  const cancelOpen = () => {
    if (enterTimer.current) clearTimeout(enterTimer.current);
    enterTimer.current = undefined;
    pending.current = null;
  };

  return { active, setActive, arm, onMouseEnter, onMouseLeave, cancelOpen };
}
