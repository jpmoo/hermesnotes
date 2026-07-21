import { ListFilter, PanelRight, Pin, X } from "lucide-react";
import { useHoverIntent } from "../lib/useHoverIntent.ts";
import { useRightPanel } from "../lib/right-panel.tsx";

/**
 * Auto-hiding right panel. A routed page can portal content into its slot and
 * flag `hasContent`; the panel then reveals on hover, and can be pinned open.
 */
export function RightPanel() {
  const { setSlotEl, active, setActive, title, hasContent } = useRightPanel();
  const { active: hovered, onMouseEnter, onMouseLeave } = useHoverIntent();
  const expanded = active || hovered;

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
        {hasContent && (
          <div className="panel-head">
            <span className="panel-title">{title}</span>
            {active ? (
              <button className="icon-btn" title="Unpin" onClick={() => setActive(false)}>
                <X size={15} />
              </button>
            ) : (
              <button className="icon-btn" title="Pin open" onClick={() => setActive(true)}>
                <Pin size={14} />
              </button>
            )}
          </div>
        )}
        <div ref={setSlotEl} />
        {!hasContent && <div className="panel-placeholder">Note info &amp; options</div>}
      </div>
    </aside>
  );
}
