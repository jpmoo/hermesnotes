import { ChevronLeft, ChevronRight, Info, Menu, X } from "lucide-react";
import { usePanels } from "../lib/right-panel.tsx";
import { WingMark } from "./WingMark.tsx";

/**
 * Phone-only top bar: a menu button that drops the rail down as a compact
 * menu, back/forward, and an Info button that slides the right panel up as a
 * sheet. The rail and panel stay mounted (so their content/slots are
 * unchanged) — CSS reshapes them for the small screen; this bar just toggles.
 */
export function MobileBar({
  navOpen,
  onToggleNav,
  infoOpen,
  onToggleInfo,
}: {
  navOpen: boolean;
  onToggleNav: () => void;
  infoOpen: boolean;
  onToggleInfo: () => void;
}) {
  const { back, forward, canBack, canForward, selectedBlockId } = usePanels();
  return (
    <div className="mobile-bar">
      <button
        className="icon-btn mobile-menu-btn"
        title={navOpen ? "Close menu" : "Menu"}
        onClick={onToggleNav}
      >
        {navOpen ? <X size={18} /> : <Menu size={18} />}
      </button>
      <button className="icon-btn" title="Back" disabled={!canBack} onClick={back}>
        <ChevronLeft size={18} />
      </button>
      <button className="icon-btn" title="Forward" disabled={!canForward} onClick={forward}>
        <ChevronRight size={18} />
      </button>
      <WingMark className="mobile-logo" size={22} title="Hermes" />
      <button
        className={`icon-btn mobile-info-btn${infoOpen ? " on" : ""}${selectedBlockId ? " has-sel" : ""}`}
        title="Info"
        onClick={onToggleInfo}
      >
        <Info size={18} />
      </button>
    </div>
  );
}
