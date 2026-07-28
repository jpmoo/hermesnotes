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
    if (enterTimer.current) clearTimeout(enterTimer.current);
    enterTimer.current = setTimeout(() => setActive(true), delay);
  };
  const onMouseEnter = () => arm();
  const onMouseLeave = () => {
    if (enterTimer.current) clearTimeout(enterTimer.current);
    leaveTimer.current = setTimeout(() => setActive(false), leaveDelay);
  };
  // Cancel a pending open without collapsing (e.g. moving onto an icon).
  const cancelOpen = () => {
    if (enterTimer.current) clearTimeout(enterTimer.current);
  };

  return { active, setActive, arm, onMouseEnter, onMouseLeave, cancelOpen };
}
