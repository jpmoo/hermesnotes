import type { ReactNode } from "react";
import { useMenuPosition } from "../lib/menu-position.ts";

/**
 * A menu opened at the point that was clicked, kept inside the window.
 * A component rather than a bare hook so it can be mounted only while the menu
 * is open (which is what makes it re-measure each time it appears).
 */
export function PointerMenu({
  x,
  y,
  className = "menu cv-menu",
  children,
}: {
  x: number;
  y: number;
  className?: string;
  children: ReactNode;
}) {
  const [ref, style] = useMenuPosition(x, y);
  return (
    <div ref={ref} className={className} style={style}>
      {children}
    </div>
  );
}
