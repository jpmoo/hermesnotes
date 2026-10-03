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
  onPick,
  children,
}: {
  x: number;
  y: number;
  className?: string;
  /**
   * Called after any button in the menu has done its job — the menu's way of
   * going away once something was chosen. Each item used to have to close the
   * menu itself, and the styling ones (a border width, an arrow, a colour)
   * deliberately did not, so choosing one left the menu standing and read as
   * a menu that would not dismiss. Bubbling, so the item's own handler runs
   * first. A colour input is not a button and keeps the menu up while its
   * picker is open.
   */
  onPick?: () => void;
  children: ReactNode;
}) {
  const [ref, style] = useMenuPosition(x, y);
  return (
    <div
      ref={ref}
      className={className}
      style={style}
      onClick={onPick ? (e) => (e.target as HTMLElement).closest("button") && onPick() : undefined}
    >
      {children}
    </div>
  );
}
