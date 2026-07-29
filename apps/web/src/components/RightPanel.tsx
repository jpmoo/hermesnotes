import { Info, PanelRight, Pin, PinOff, Share2, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { usePanels } from "../lib/right-panel.tsx";
import { useAiConfig } from "../lib/ai-config.tsx";
import { useAssistant } from "../lib/assistant.tsx";
import { AIPanel } from "./AIPanel.tsx";
import { BlockInfoPane } from "./BlockInfoPane.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { FeedEventPane } from "./FeedEventPane.tsx";
import { GraphPanel } from "./GraphPanel.tsx";

type Tab = "info" | "graph" | "ai";
const readTab = (): Tab => {
  try {
    const v = localStorage.getItem("hn.panel.tab");
    return v === "graph" || v === "ai" ? v : "info";
  } catch {
    return "info";
  }
};

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
    selectedFeedEvent,
    selectFeedEvent,
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
  const showFeedEvent = selectedFeedEvent !== null;
  const showInfo = selectedBlockId !== null && !showFeedEvent;

  const { ai: aiEnabled } = useAiConfig();
  // The AI-tab "clear conversation" action lives up in the header (next to the
  // pin) instead of its own toolbar row.
  const { msgs: aiMsgs, busy: aiBusy, clear: clearAi } = useAssistant();
  const [confirmClear, setConfirmClear] = useState(false);
  const [tab, setTabRaw] = useState<Tab>(readTab);
  const setTab = (t: Tab) => {
    setTabRaw(t);
    try {
      localStorage.setItem("hn.panel.tab", t);
    } catch {
      /* ignore */
    }
  };
  // With no inference model configured, the AI tab is hidden — fall back to Info.
  const activeTab: Tab = tab === "ai" && !aiEnabled ? "info" : tab;
  const tabTitle = activeTab === "graph" ? "Graph" : activeTab === "ai" ? "AI" : "Info";

  return (
    <aside ref={asideRef} className={`right-panel${expanded ? " expanded" : ""}`}>
      <div className="panel-rail-icon" title="Info">
        {hasContent || showInfo || showFeedEvent ? <Info size={18} /> : <PanelRight size={18} />}
      </div>
      <div className="panel-body">
        <div className="panel-head">
          <span className="panel-title">{tabTitle}</span>
          {activeTab === "ai" && aiMsgs.length > 0 && (
            <button
              className="icon-btn"
              title="Clear conversation"
              disabled={aiBusy}
              style={{ marginLeft: "auto", marginRight: 4 }}
              onClick={() => setConfirmClear(true)}
            >
              <Trash2 size={14} />
            </button>
          )}
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

        <div className="panel-main">
          {/* Info content stays mounted (pages portal into its slots); other
              tabs just hide it. */}
          <div className={`panel-scroll${activeTab === "info" ? "" : " hidden"}`}>
            <div ref={setSlotEl} />
            {showFeedEvent && (
              <FeedEventPane event={selectedFeedEvent} onConverted={() => selectFeedEvent(null)} />
            )}
            {showInfo && (
              <BlockInfoPane
                blockId={selectedBlockId}
                titleOverride={selectedToday ? `Daily Note for ${fmtLongDate(selectedToday)}` : undefined}
                onSelect={(id) => openBlock(id)}
                onSelectCollection={(id) => openBlock(id, { collection: true })}
                onDeleted={clearSelection}
              />
            )}
            <div className="panel-bottom-slot" ref={setBottomSlotEl} />
            {!hasContent && !showInfo && !showFeedEvent && (
              <div className="panel-placeholder">
                Select a block or collection to see and edit information here.
              </div>
            )}
          </div>
          {activeTab === "graph" && (
            <div className="panel-tabview">
              <GraphPanel />
            </div>
          )}
          {activeTab === "ai" && (
            <div className="panel-tabview">
              <AIPanel />
            </div>
          )}
        </div>

        <div className="panel-tabs">
          <button className={`panel-tab${activeTab === "info" ? " active" : ""}`} onClick={() => setTab("info")}>
            <Info size={14} /> Info
          </button>
          <button className={`panel-tab${activeTab === "graph" ? " active" : ""}`} onClick={() => setTab("graph")}>
            <Share2 size={14} /> Graph
          </button>
          {aiEnabled && (
            <button className={`panel-tab${activeTab === "ai" ? " active" : ""}`} onClick={() => setTab("ai")}>
              <Sparkles size={14} /> AI
            </button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmClear}
        title="Clear conversation?"
        message="This permanently deletes the whole assistant conversation and resets its memory. This can't be undone."
        confirmLabel="Clear"
        onConfirm={() => {
          setConfirmClear(false);
          void clearAi();
        }}
        onCancel={() => setConfirmClear(false)}
      />
    </aside>
  );
}
