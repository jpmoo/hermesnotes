import { AlertTriangle, ArrowLeft, ArrowUp, MessageCircle, Sparkles, Square, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAssistant } from "../lib/assistant.tsx";
import { Markdown } from "./Markdown.tsx";

/**
 * In-app AI assistant: a thin view over the shell-level AssistantProvider, which
 * persists the conversation server-side and keeps a running turn alive across
 * tab switches. This component only owns the composer text and scroll position.
 */
export function AIPanel() {
  const { msgs, busy, error, send, stop, resolvePending, thread, openThread } = useAssistant();
  const [input, setInput] = useState("");
  const threadRef = useRef<HTMLDivElement>(null);

  /**
   * Whether the view is following the end of the conversation.
   *
   * It used to scroll to the bottom on every change, which during a streamed
   * reply is every token: scrolling up to start reading the answer was undone
   * a few milliseconds later, until the whole thing had finished. Now it
   * follows only while you are at the bottom. Scroll up and it stays where you
   * put it; scroll back down to the end and it picks up again. Sending a
   * message always returns to the end — that is where the answer will be.
   */
  const following = useRef(true);
  /**
   * Letting go is decided by what the *person* does, before the view moves.
   *
   * Reading it off scroll events lost a race: tokens arrive every few
   * milliseconds, each one scrolls the view back to the end, and the browser
   * sends one scroll event per frame — so by the time the event for a scroll
   * up arrived, the panel had already pulled the view down again, the event
   * said "at the bottom", and it kept following. A wheel or a swipe upward, a
   * key that moves up, or taking hold of the scrollbar is the intent itself,
   * and arrives first.
   */
  const letGo = () => {
    following.current = false;
  };
  const onWheel = (e: React.WheelEvent) => e.deltaY < 0 && letGo();
  const onThreadKey = (e: React.KeyboardEvent) =>
    ["PageUp", "ArrowUp", "Home"].includes(e.key) && letGo();
  const onPointerDown = (e: React.PointerEvent) => {
    const el = threadRef.current;
    // A press right of the content is on the scrollbar.
    if (el && e.nativeEvent.offsetX > el.clientWidth) letGo();
  };
  /** Back at the end — by wheel, by scrollbar, by any means — takes hold again. */
  const onScroll = () => {
    const el = threadRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 24) following.current = true;
  };
  // Another conversation opens at its end, wherever you had scrolled to in
  // the last one.
  useEffect(() => {
    following.current = true;
  }, [thread?.id]);
  useEffect(() => {
    if (following.current) threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [msgs, busy]);

  const submit = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    following.current = true;
    void send(text);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="ai-panel">
      {/* Which conversation this is. A discussion is a bubble on a canvas, read
          with what is connected to it; saying so is the difference between
          "the assistant forgot everything" and "this is a different chat". */}
      {thread && (
        <div className="ai-discussion">
          <MessageCircle size={14} />
          <span className="ai-discussion-title" title={thread.title || undefined}>
            {thread.title || "New discussion"}
          </span>
          <button className="ai-discussion-back" onClick={() => openThread(null)} title="Back to the assistant">
            <ArrowLeft size={13} /> Assistant
          </button>
        </div>
      )}
      <div
        className="ai-thread"
        ref={threadRef}
        onScroll={onScroll}
        onWheel={onWheel}
        onTouchMove={letGo}
        onKeyDown={onThreadKey}
        onPointerDown={onPointerDown}
      >
        {msgs.length === 0 && thread && (
          <div className="ai-empty">
            <MessageCircle size={22} />
            <p>This discussion reads what is connected to its node on the canvas.</p>
            <ul className="ai-suggest">
              <li>"I'm considering doing X. Given the context, what are the pros and cons?"</li>
              <li>"What am I missing?"</li>
              <li>"Compare this with the other options discussed here"</li>
            </ul>
          </div>
        )}
        {msgs.length === 0 && !thread && (
          <div className="ai-empty">
            <Sparkles size={22} />
            <p>Ask me to find, create, or organize anything.</p>
            <ul className="ai-suggest">
              <li>"Make a task to email Sam due Friday"</li>
              <li>"Find my notes about the rebuild"</li>
              <li>"Arrange my open tasks on a new canvas called Task List"</li>
            </ul>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`ai-msg ai-${m.role}`}>
            {m.steps && m.steps.length > 0 && (
              <div className="ai-steps">
                {m.steps.map((s, j) => (
                  <div key={j} className={`ai-step${s.ok ? "" : " err"}`} title={s.result}>
                    <Wrench size={12} />
                    <span className="ai-step-name">{s.tool}</span>
                    <span className="ai-step-result">{firstLine(s.result)}</span>
                  </div>
                ))}
              </div>
            )}
            {m.content ? (
              <div className="ai-bubble">
                {m.role === "assistant" ? <Markdown>{m.content}</Markdown> : m.content}
              </div>
            ) : (
              // Streaming, but nothing to show yet (before the first token, or
              // while the next model turn runs after a tool): pulse while we wait.
              m.streaming && (
                <div className="ai-bubble ai-thinking">
                  <span className="ai-dot" />
                  <span className="ai-dot" />
                  <span className="ai-dot" />
                </div>
              )
            )}
            {m.pending && m.pending.length > 0 && !m.resolved && (
              <div className="ai-confirm">
                <div className="ai-confirm-head">
                  <AlertTriangle size={14} />
                  <span>Confirm {m.pending.length === 1 ? "this action" : "these actions"}</span>
                </div>
                {m.pending.map((p, j) => (
                  <div key={j} className="ai-confirm-item">
                    <Wrench size={12} />
                    <span className="ai-step-name">{p.tool}</span>
                    <span className="ai-step-result">{summarizeArgs(p.args)}</span>
                  </div>
                ))}
                <div className="ai-confirm-actions">
                  <button className="danger" onClick={() => void resolvePending(i, true)} disabled={busy}>
                    Confirm
                  </button>
                  <button className="ghost" onClick={() => void resolvePending(i, false)} disabled={busy}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
        {error && <div className="ai-error">{error}</div>}
      </div>

      <div className="ai-composer">
        <textarea
          className="ai-input"
          placeholder="Ask the assistant…"
          value={input}
          rows={3}
          autoComplete="off"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {busy ? (
          <button className="icon-btn ai-send ai-stop" title="Stop" onClick={stop}>
            <Square size={13} fill="currentColor" />
          </button>
        ) : (
          <button className="icon-btn ai-send" title="Send" disabled={!input.trim()} onClick={submit}>
            <ArrowUp size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

function firstLine(s: string): string {
  const line = s.split("\n")[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const parts = Object.entries(args as Record<string, unknown>).map(([k, v]) => `${k}: ${String(v)}`);
  const s = parts.join(", ");
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
}
