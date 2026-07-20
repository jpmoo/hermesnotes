import { PanelRight } from "lucide-react";
import { useHoverIntent } from "../lib/useHoverIntent.ts";

/**
 * Auto-hiding right panel (mirrors the left sidebar): a 56px rail that reveals
 * on hover (with a short intent delay). Placeholder for now.
 */
export function RightPanel() {
  const { active, onMouseEnter, onMouseLeave } = useHoverIntent();
  return (
    <aside
      className={`right-panel${active ? " expanded" : ""}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="panel-rail-icon" title="Note info & options">
        <PanelRight size={18} />
      </div>
      <div className="panel-body">
        <div className="panel-placeholder">Note info &amp; options</div>
      </div>
    </aside>
  );
}
