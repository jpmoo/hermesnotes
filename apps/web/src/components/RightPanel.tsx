import { Info, PanelRight, Pin, PinOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
    hasContent,
    selectedBlockId,
    selectedToday,
    openBlock,
    clearSelection,
  } = usePanels();
  const asideRef = useRef<HTMLElement>(null);

  // Keep-open is driven by the pointer's geometry, not mouseenter/leave — the
  // latter misfired with the panel's width transition and portaled content
  // (e.g. the Today calendar), collapsing the panel while the cursor was still
  // over it. `over` = pointer within the panel's rect (+ a small left grace),
  // with a short leave delay.
  const [over, setOver] = useState(false);
  useEffect(() => {
    let leave: ReturnType<typeof setTimeout> | undefined;
    const onMove = (e: PointerEvent) => {
      const el = asideRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const inside =
        e.clientX >= r.left - 10 && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (inside) {
        clearTimeout(leave);
        setOver(true);
      } else {
        clearTimeout(leave);
        leave = setTimeout(() => setOver(false), 240);
      }
    };
    document.addEventListener("pointermove", onMove);
    return () => {
      document.removeEventListener("pointermove", onMove);
      clearTimeout(leave);
    };
  }, []);

  // Also hold open while a pointer interaction started inside it is ongoing, or
  // while focus is inside it (drags that stray outside, typing in the builder).
  const [holdOpen, setHoldOpen] = useState(false);
  useEffect(() => {
    const el = asideRef.current;
    if (!el) return;
    let pointerHeld = false;
    const update = () => setHoldOpen(pointerHeld || el.contains(document.activeElement));
    const onFocusIn = () => update();
    const onFocusOut = () => setTimeout(update, 0);
    const onPointerDown = () => {
      pointerHeld = true;
      update();
    };
    const onPointerUp = () => {
      pointerHeld = false;
      setTimeout(update, 0);
    };
    el.addEventListener("focusin", onFocusIn);
    el.addEventListener("focusout", onFocusOut);
    el.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointerup", onPointerUp);
    return () => {
      el.removeEventListener("focusin", onFocusIn);
      el.removeEventListener("focusout", onFocusOut);
      el.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  const expanded = rightPinned || over || holdOpen;
  const showInfo = selectedBlockId !== null;

  return (
    <aside ref={asideRef} className={`right-panel${expanded ? " expanded" : ""}`}>
      <div className="panel-rail-icon" title="Info">
        {hasContent || showInfo ? <Info size={18} /> : <PanelRight size={18} />}
      </div>
      <div className="panel-body">
        <div className="panel-head">
          <span className="panel-title">Info</span>
          <button
            className="icon-btn panel-pin"
            title={rightPinned ? "Unpin panel" : "Pin panel open"}
            onClick={() => {
              if (rightPinned) {
                setRightPinned(false);
                setOver(false); // collapse to the rail on unpin
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
          <BlockInfoPane
            blockId={selectedBlockId}
            titleOverride={selectedToday ? `Daily Note for ${fmtLongDate(selectedToday)}` : undefined}
            onSelect={(id) => openBlock(id)}
            onSelectCollection={(id) => openBlock(id, { collection: true })}
            onDeleted={clearSelection}
          />
        )}
        <div ref={setBottomSlotEl} />
        {!hasContent && !showInfo && <div className="panel-placeholder">Note info &amp; options</div>}
      </div>
    </aside>
  );
}
