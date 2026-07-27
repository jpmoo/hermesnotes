import { AlertTriangle, ArrowUp, Sparkles, Trash2, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAssistant } from "../lib/assistant.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { Markdown } from "./Markdown.tsx";

/**
 * In-app AI assistant: a thin view over the shell-level AssistantProvider, which
 * persists the conversation server-side and keeps a running turn alive across
 * tab switches. This component only owns the composer text and scroll position.
 */
export function AIPanel() {
  const { msgs, busy, error, send, resolvePending, clear } = useAssistant();
  const [input, setInput] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [msgs, busy]);

  const submit = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
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
      {msgs.length > 0 && (
        <div className="ai-toolbar">
          <button
            className="icon-btn"
            title="Clear conversation"
            onClick={() => setConfirmClear(true)}
            disabled={busy}
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}
      <div className="ai-thread" ref={threadRef}>
        {msgs.length === 0 && (
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
            {m.content && (
              <div className="ai-bubble">
                {m.role === "assistant" ? <Markdown>{m.content}</Markdown> : m.content}
              </div>
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
        {busy && (
          <div className="ai-msg ai-assistant">
            <div className="ai-bubble ai-thinking">
              <span className="ai-dot" />
              <span className="ai-dot" />
              <span className="ai-dot" />
            </div>
          </div>
        )}
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
        <button className="icon-btn ai-send" title="Send" disabled={busy || !input.trim()} onClick={submit}>
          <ArrowUp size={16} />
        </button>
      </div>

      <ConfirmDialog
        open={confirmClear}
        title="Clear conversation?"
        message="This permanently deletes the whole assistant conversation and resets its memory. This can't be undone."
        confirmLabel="Clear"
        onConfirm={() => {
          setConfirmClear(false);
          void clear();
        }}
        onCancel={() => setConfirmClear(false)}
      />
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
