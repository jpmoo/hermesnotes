import { Info, PanelRight, Pin, PinOff } from "lucide-react";
import { useHoverIntent } from "../lib/useHoverIntent.ts";
import { usePanels } from "../lib/right-panel.tsx";
import { BlockInfoPane } from "./BlockInfoPane.tsx";

/**
 * Auto-hiding right panel. Reveals on hover; can be pinned open. A routed page
 * can portal content into its slot and flag `hasContent`.
 */
const fmtLongDate = (date: string) =>
  new Date(`${date}T00:00`).toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

export function RightPanel() {
  const {
    setSlotEl,
    setBottomSlotEl,
    rightPinned,
    setRightPinned,
    title,
    hasContent,
    selectedBlockId,
    selectedToday,
    openBlock,
  } = usePanels();
  const { active: hovered, setActive: setHovered, onMouseEnter, onMouseLeave } = useHoverIntent();
  const expanded = rightPinned || hovered;
  const showInfo = selectedBlockId !== null;

  return (
    <aside
      className={`right-panel${expanded ? " expanded" : ""}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="panel-rail-icon" title={hasContent ? title : "Note info & options"}>
        {hasContent || showInfo ? <Info size={18} /> : <PanelRight size={18} />}
      </div>
      <div className="panel-body">
        <div className="panel-head">
          <span className="panel-title">{hasContent ? title : "Details"}</span>
          <button
            className="icon-btn panel-pin"
            title={rightPinned ? "Unpin panel" : "Pin panel open"}
            onClick={() => {
              if (rightPinned) {
                setRightPinned(false);
                setHovered(false); // collapse to the rail on unpin
              } else {
                setRightPinned(true);
              }
            }}
          >
            {rightPinned ? <PinOff size={14} /> : <Pin size={14} />}
          </button>
        </div>
        <div ref={setSlotEl} />
        {showInfo && (
          <>
            {hasContent && <div className="panel-divider" />}
            <BlockInfoPane
              blockId={selectedBlockId}
              titleOverride={selectedToday ? `Daily Note for ${fmtLongDate(selectedToday)}` : undefined}
              onSelect={(id) => openBlock(id)}
              onSelectCollection={(id) => openBlock(id, { collection: true })}
            />
          </>
        )}
        <div ref={setBottomSlotEl} />
        {!hasContent && !showInfo && <div className="panel-placeholder">Note info &amp; options</div>}
      </div>
    </aside>
  );
}
