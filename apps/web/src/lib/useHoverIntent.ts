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
  const pending = useRef<{ at: number; delay: number; kind: string } | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>();

  // Arm the reveal after a dwell. Callers can pass a delay to override the
  // default per-region (e.g. a longer dwell over clickable icons — where the
  // cursor is likely just passing to a click — and a shorter one over empty
  // rail space, where a hover almost always means "open me").
  /**
   * Arm the reveal after a dwell. `kind` names the sort of place the pointer is
   * in, and it's what decides whether a running dwell is disturbed:
   *
   * - same kind — leave it alone. mouseover fires again for every descendant
   *   crossed (an icon, its glyph, its label), and restarting each time meant
   *   the countdown never finished over a row of icons.
   * - a different kind — start again on the new terms. Crossing from a gap onto
   *   an icon really is a change of mind about what you're doing, and should
   *   buy the icon its longer wait rather than coast in on the quick one.
   */
  const arm = (delay = enterDelay, kind = "default") => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    if (enterTimer.current && pending.current) {
      if (pending.current.kind === kind) return;
      clearTimeout(enterTimer.current);
    }
    pending.current = { at: Date.now(), delay, kind };
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
