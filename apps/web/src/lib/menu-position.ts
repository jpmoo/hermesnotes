import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

/**
 * Keep a menu opened at a point on screen inside the window.
 *
 * A right-click near the bottom or right edge would otherwise hang a menu off
 * the screen, and the entries you wanted are the ones that fall off. So it
 * opens down-right of the pointer where there's room, flips back over the
 * pointer where there isn't, and — for a menu taller than the window at any
 * position — sits against the top and scrolls.
 *
 * Measured after layout rather than guessed from a fixed size: these menus
 * carry whatever the thing under the pointer offers, so their height isn't
 * known until they exist.
 */
const MARGIN = 8;

export function useMenuPosition(x: number, y: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({
    position: "fixed",
    left: x,
    top: y,
    right: "auto",
    // Hidden for the frame between mounting and measuring, so the menu is never
    // seen in the wrong place.
    visibility: "hidden",
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const { width, height } = el.getBoundingClientRect();
      const maxH = window.innerHeight - MARGIN * 2;
      const h = Math.min(height, maxH);
      const left =
        x + width > window.innerWidth - MARGIN
          ? Math.max(MARGIN, Math.min(x - width, window.innerWidth - width - MARGIN))
          : x;
      const top =
        y + h > window.innerHeight - MARGIN
          ? Math.max(MARGIN, Math.min(y - h, window.innerHeight - h - MARGIN))
          : y;
      setStyle({
        position: "fixed",
        left,
        top,
        right: "auto",
        maxHeight: maxH,
        overflowY: height > maxH ? "auto" : undefined,
      });
    };
    place();
    // The contents can arrive late (a menu that fetches its block types), which
    // changes the height after the first measurement.
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [x, y]);

  return [ref, style] as const;
}
