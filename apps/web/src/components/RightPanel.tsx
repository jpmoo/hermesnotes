import { ListFilter, PanelRight, Pin, PinOff } from "lucide-react";
import { useHoverIntent } from "../lib/useHoverIntent.ts";
import { usePanels } from "../lib/right-panel.tsx";

/**
 * Auto-hiding right panel. Reveals on hover; can be pinned open. A routed page
 * can portal content into its slot and flag `hasContent`.
 */
export function RightPanel() {
  const { setSlotEl, rightPinned, setRightPinned, title, hasContent } = usePanels();
  const { active: hovered, onMouseEnter, onMouseLeave } = useHoverIntent();
  const expanded = rightPinned || hovered;

  return (
    <aside
      className={`right-panel${expanded ? " expanded" : ""}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="panel-rail-icon" title={hasContent ? title : "Note info & options"}>
        {hasContent ? <ListFilter size={18} /> : <PanelRight size={18} />}
      </div>
      <div className="panel-body">
        <div className="panel-head">
          <span className="panel-title">{hasContent ? title : "Details"}</span>
          <button
            className="icon-btn panel-pin"
            title={rightPinned ? "Unpin panel" : "Pin panel open"}
            onClick={() => setRightPinned(!rightPinned)}
          >
            {rightPinned ? <PinOff size={14} /> : <Pin size={14} />}
          </button>
        </div>
        <div ref={setSlotEl} />
        {!hasContent && <div className="panel-placeholder">Note info &amp; options</div>}
      </div>
    </aside>
  );
}
