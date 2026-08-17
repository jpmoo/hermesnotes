import { Info, PanelRight, Pin, PinOff, Share2, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { isEditingTarget } from "../lib/editing-target.ts";
import { classifyPress } from "../lib/press.ts";
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
 * Auto-hiding right panel. Opens when you ask for something — a card, a row, a
 * chip — and closes when you press the page itself or the thing it's already
 * showing. Never on hover: crossing it on the way somewhere is not a request to
 * read it, and reading it shouldn't be a race against a timer. Can be pinned. A
 * routed page can portal content into its slot and flag `hasContent`.
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

  /**
   * Open because something was asked for. The panel is driven by presses and
   * nothing else — it no longer watches where the pointer is, so it can't open
   * because you crossed it on the way somewhere, or shut because you left it
   * sitting there while you read.
   */
  const [revealed, setRevealed] = useState(false);
  /** Where the last press landed, for deciding what that press meant. */
  const pressedOn = useRef<HTMLElement | null>(null);
  /**
   * Whether the reveal was up when that press began — read before the press
   * itself closes it, so a press on the thing already being shown can be told
   * apart from a press on something new.
   */
  const openAtPress = useRef(false);
  const revealedRef = useRef(false);
  revealedRef.current = revealed;
  const shownId = useRef<string | null>(null);
  // Whatever the panel is showing, block or feed event, under one key.
  shownId.current = selectedFeedEvent
    ? `${selectedFeedEvent.feedId}|${selectedFeedEvent.uid}`
    : selectedBlockId;
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      pressedOn.current = e.target as HTMLElement;
      openAtPress.current = revealedRef.current;
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, []);
  // Hold open while a pointer interaction started inside it is ongoing, or
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
    const editing = isEditingTarget(from);
    // A selection made from inside the panel doesn't need the panel revealed.
    const fromPanel = !!from && !!asideRef.current?.contains(from);
    if (editing || fromPanel) return;
    // The same thing again, while it's already up: that's a toggle. Clicking a
    // card twice to make the panel go away is the obvious thing to try, and
    // re-showing what's already shown does nothing anyone can see.
    const pressed = pressedOn.current?.closest?.<HTMLElement>("[data-block-id], [data-feed-key]");
    const pressedId = pressed?.dataset.blockId ?? pressed?.dataset.feedKey;
    if (openAtPress.current && pressedId && pressedId === shownId.current) {
      setRevealed(false);
      return;
    }
    setRevealed(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealTick]);

  /**
   * What puts it away: the page itself, or the thing it's already showing.
   *
   * Not "any press outside", which is what this used to be. Walking from one
   * card to the next was meant to survive that by the selection reopening the
   * panel on the way through — but a press into a card's title or body is a
   * press into a field, and the reveal declines to open over the top of writing.
   * So the panel shut and stayed shut, and the answer to "show me this one
   * instead" was to be shown nothing.
   *
   * A press on something else leaves it alone. Either that thing gets selected,
   * and the contents swap under a panel that never went anywhere, or it doesn't,
   * and there was no reason to close.
   */
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const press = classifyPress(e.target);
      // Pressing the panel — including the sliver of rail it collapses to — is
      // asking to read it. With hover gone this is the only way in that isn't a
      // request to look at something, and without it the rail would be a strip
      // that does nothing.
      if (press.kind === "panel") {
        if (press.side === "right") setRevealed(true);
        return;
      }
      if (press.kind === "empty" || (press.kind === "thing" && press.id === shownId.current)) {
        setRevealed(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, []);

  // Escape puts it away without having to go and touch it.
  useEffect(() => {
    if (!revealed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRevealed(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [revealed]);

  const expanded = rightPinned || holdOpen || revealed;
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
