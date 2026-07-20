import { PanelRight } from "lucide-react";
import { useState } from "react";

/**
 * Auto-hiding right panel (mirrors the left sidebar): a 56px rail that reveals
 * on hover. Empty placeholder for now — note info & options will live here.
 */
export function RightPanel() {
  const [hovered, setHovered] = useState(false);
  return (
    <aside
      className={`right-panel${hovered ? " expanded" : ""}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
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
