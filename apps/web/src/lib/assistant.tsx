import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError, type AgentReply, type AgentStep, type PendingCall } from "../api.ts";

export interface AssistantMsg {
  role: "user" | "assistant";
  content: string;
  steps?: AgentStep[];
  pending?: PendingCall[];
  resolved?: boolean;
}

interface AssistantValue {
  msgs: AssistantMsg[];
  busy: boolean;
  error: string | null;
  send: (text: string) => Promise<void>;
  resolvePending: (idx: number, approve: boolean) => Promise<void>;
  clear: () => Promise<void>;
}

const Ctx = createContext<AssistantValue | null>(null);

/**
 * Holds the AI conversation ABOVE the right-panel tabs, so switching to Info or
 * Graph (or a turn still running) never unmounts it. History is persisted
 * server-side; we hydrate once on mount and send only the new message each turn.
 */
export function AssistantProvider({ children }: { children: ReactNode }) {
  const [msgs, setMsgs] = useState<AssistantMsg[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void api
      .get<{ messages: AssistantMsg[] }>("/assistant/messages")
      .then((d) => setMsgs(d.messages))
      .catch(() => {});
  }, []);

  const send = async (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    setError(null);
    setMsgs((m) => [...m, { role: "user", content: t }]);
    setBusy(true);
    try {
      const res = await api.post<AgentReply>("/assistant/chat", { message: t });
      setMsgs((m) => [...m, { role: "assistant", content: res.reply, steps: res.steps, pending: res.pending }]);
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

  const clear = async () => {
    await api.del("/assistant/messages").catch(() => {});
    setMsgs([]);
    setError(null);
  };

  return (
    <Ctx.Provider value={{ msgs, busy, error, send, resolvePending, clear }}>{children}</Ctx.Provider>
  );
}

export function useAssistant(): AssistantValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAssistant must be used within AssistantProvider");
  return v;
}
