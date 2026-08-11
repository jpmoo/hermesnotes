import { useRef, useState } from "react";

/**
 * Hover-intent: reveal after a short dwell, hide after a brief grace period —
 * so the auto-hiding panels don't flicker open when the cursor merely passes by.
 */
export function useHoverIntent(enterDelay = 320, leaveDelay = 220) {
  const [active, setActive] = useState(false);
  const enterTimer = useRef<ReturnType<typeof setTimeout>>();
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>();

  // Arm the reveal after a dwell. Callers can pass a delay to override the
  // default per-region (e.g. a longer dwell over clickable icons — where the
  // cursor is likely just passing to a click — and a shorter one over empty
  // rail space, where a hover almost always means "open me").
  const arm = (delay = enterDelay) => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    // Don't restart a dwell that's already running. mouseover fires again for
    // every descendant the pointer crosses — an icon, its glyph, its label — so
    // restarting meant the countdown reset each time and, over a row of icons,
    // never finished. The dwell is meant to time how long you've been in the
    // region, not how long since the last element boundary.
    if (enterTimer.current) return;
    enterTimer.current = setTimeout(() => {
      enterTimer.current = undefined;
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
  };

  return { active, setActive, arm, onMouseEnter, onMouseLeave, cancelOpen };
}
