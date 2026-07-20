import { useRef, useState } from "react";

/**
 * Hover-intent: reveal after a short dwell, hide after a brief grace period —
 * so the auto-hiding panels don't flicker open when the cursor merely passes by.
 */
export function useHoverIntent(enterDelay = 320, leaveDelay = 220) {
  const [active, setActive] = useState(false);
  const enterTimer = useRef<ReturnType<typeof setTimeout>>();
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>();

  const onMouseEnter = () => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    enterTimer.current = setTimeout(() => setActive(true), enterDelay);
  };
  const onMouseLeave = () => {
    if (enterTimer.current) clearTimeout(enterTimer.current);
    leaveTimer.current = setTimeout(() => setActive(false), leaveDelay);
  };

  return { active, setActive, onMouseEnter, onMouseLeave };
}
