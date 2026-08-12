import { Info, PanelRight, Pin, PinOff, Share2, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { usePanels } from "../lib/right-panel.tsx";
import { useIsMobile } from "../lib/useIsMobile.ts";
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
    revealTick,
  } = usePanels();
  const isMobile = useIsMobile();
  const asideRef = useRef<HTMLElement>(null);
  const { pathname } = useLocation();

  // Keep-open is driven by the pointer's geometry, not mouseenter/leave — the
  // latter misfired with the panel's width transition and portaled content
  // (e.g. the Today calendar), collapsing the panel while the cursor was still
  // over it. `over` = pointer within the panel's rect (+ a small left grace),
  // with a short leave delay.
  const [over, setOver] = useState(false);
  /**
   * Set when the panel is collapsed deliberately, and cleared the moment the
   * pointer leaves it. Hover is tracked by position rather than by enter/leave,
   * so the pointer sitting on the pin button counts as "over the panel" — and
   * unpinning collapsed it and then reopened it under the cursor, which reads as
   * the button not working. The panel stays shut until the pointer goes away and
   * comes back, which is the gesture that means "show me it" again.
   */
  const ignoreHover = useRef(false);
  /**
   * Shown because something was selected rather than because the pointer is
   * here. Clicking a card is a request to look at it, and a shut panel makes
   * that click look like it did nothing.
   *
   * It can't be tied to the pointer being over the panel: the pointer is on the
   * card that was just clicked, which is somewhere else entirely, so the reveal
   * would open and shut again within the grace period — a stutter, and worse on
   * an embedded card where the click lands further away. It stays until it has
   * been used and left: once the pointer has been inside the panel, leaving
   * closes it. Selecting something else keeps it open and swaps the contents,
   * which is what walking down a list of cards is.
   */
  const [revealed, setRevealed] = useState(false);
  const visited = useRef(false);
  /** Where the last press landed, for deciding what that press meant. */
  const pressedOn = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      pressedOn.current = e.target as HTMLElement;
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, []);
  useEffect(() => {
    let leave: ReturnType<typeof setTimeout> | undefined;
    const onMove = (e: PointerEvent) => {
      const el = asideRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const inside =
        e.clientX >= r.left - 10 && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (inside) {
        visited.current = true;
        if (ignoreHover.current) return;
        clearTimeout(leave);
        setOver(true);
      } else {
        ignoreHover.current = false;
        clearTimeout(leave);
        leave = setTimeout(() => {
          setOver(false);
          // Only once it's been visited: otherwise the pointer sitting where it
          // clicked would dismiss the thing that click asked for.
          if (visited.current) {
            visited.current = false;
            setRevealed(false);
          }
        }, 240);
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

  // Selecting something opens the panel — but not on a phone, where the panel
  // is a drawer over the page and a tap already opens the block as a page.
  useEffect(() => {
    if (revealTick === 0 || isMobile) return;
    const from = pressedOn.current;
    // Typing is not asking. Clicking into the scratchpad, a title, or any other
    // field selects that block — the panel should follow along quietly, not open
    // over the top of what's being written. Only a press on something that isn't
    // a writing surface counts as "show me this".
    const editing = !!from?.closest?.(
      'input:not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"], .md-editor, .mention-input',
    );
    // A selection made from inside the panel doesn't need the panel revealed.
    const fromPanel = !!from && !!asideRef.current?.contains(from);
    if (editing || fromPanel) return;
    visited.current = false;
    setRevealed(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealTick]);

  // Any press outside puts it away. Pressing something that selects reopens it
  // on the way through, so walking from card to card still swaps the contents.
  useEffect(() => {
    if (!revealed) return;
    const onDown = (e: PointerEvent) => {
      if (asideRef.current?.contains(e.target as Node)) return;
      setRevealed(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [revealed]);

  // Escape puts it away without having to go and touch it.
  useEffect(() => {
    if (!revealed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRevealed(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [revealed]);

  const expanded = rightPinned || over || holdOpen || revealed;
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
  // Which page the panel is sitting beside. The tools it offers (a filter, a
  // layout) belong to that page rather than to anything selected, and on a narrow
  // window the page's own heading may not be in view at all.
  const pageName = (() => {
    if (pathname.startsWith("/today")) return "Today";
    if (pathname.startsWith("/blocks")) return "All blocks";
    if (pathname.startsWith("/favorites")) return "Favorites";
    if (pathname.startsWith("/collections")) return "Collections";
    if (pathname.startsWith("/types")) return "Types";
    if (pathname.startsWith("/review")) return "Weekly review";
    if (pathname.startsWith("/archive")) return "Archive";
    if (pathname.startsWith("/settings")) return "Settings";
    return null;
  })();
  const baseTitle = activeTab === "graph" ? "Graph" : activeTab === "ai" ? "AI" : "Info";
  // Only when the panel is showing the page's own tools: with a block selected
  // it's describing that block, and naming the page would misattribute it.
  const tabTitle =
    activeTab === "info" && pageName && !showInfo && !showFeedEvent
      ? `${baseTitle} · ${pageName}`
      : baseTitle;

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
            onClick={(e) => {
              if (rightPinned) {
                setRightPinned(false);
                setOver(false); // collapse to the rail on unpin
                ignoreHover.current = true;
                // This panel also stays open while focus is inside it — which,
                // after clicking this button, means this button. Without letting
                // go of focus, unpinning left the panel open until something
                // else was clicked, doing exactly nothing visible.
                e.currentTarget.blur();
                setHoldOpen(false);
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
                Select something to see information here.
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
