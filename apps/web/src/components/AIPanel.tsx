import { AlertTriangle, ArrowUp, Sparkles, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, type AgentReply, type AgentStep, type PendingCall } from "../api.ts";
import { Markdown } from "./Markdown.tsx";

interface Msg {
  role: "user" | "assistant";
  content: string;
  steps?: AgentStep[];
  pending?: PendingCall[];
  resolved?: boolean;
}

/**
 * In-app AI assistant: a chat that drives the shared tool registry through the
 * server-side agent loop (POST /assistant/chat). Each turn sends the running
 * history and renders the reply plus the tool calls the agent made.
 */
export function AIPanel() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [msgs, busy]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setError(null);
    const history: Msg[] = [...msgs, { role: "user", content: text }];
    setMsgs(history);
    setInput("");
    setBusy(true);
    try {
      const res = await api.post<AgentReply>("/assistant/chat", {
        messages: history.map((m) => ({ role: m.role, content: m.content })),
      });
      setMsgs((m) => [
        ...m,
        { role: "assistant", content: res.reply, steps: res.steps, pending: res.pending },
      ]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message.replace(/^API \d+:?\s*/, "") : "The assistant is unavailable.");
    } finally {
      setBusy(false);
    }
  };

  const resolvePending = async (idx: number, approve: boolean) => {
    const pending = msgs[idx]?.pending;
    if (!pending) return;
    setMsgs((m) => m.map((x, i) => (i === idx ? { ...x, resolved: true } : x)));
    if (!approve) {
      setMsgs((m) => [...m, { role: "assistant", content: "Okay — cancelled, nothing was deleted." }]);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ steps: AgentStep[] }>("/assistant/confirm", { calls: pending });
      setMsgs((m) => [...m, { role: "assistant", content: "Done.", steps: res.steps }]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message.replace(/^API \d+:?\s*/, "") : "Couldn't complete that.");
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="ai-panel">
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
          rows={1}
          autoComplete="off"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button className="icon-btn ai-send" title="Send" disabled={busy || !input.trim()} onClick={() => void send()}>
          <ArrowUp size={16} />
        </button>
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
