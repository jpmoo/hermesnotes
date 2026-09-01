import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, apiBase, ApiError, CLIENT_ID, type AgentStep, type PendingCall } from "../api.ts";

export interface AssistantMsg {
  role: "user" | "assistant";
  content: string;
  steps?: AgentStep[];
  pending?: PendingCall[];
  resolved?: boolean;
  /** True while this assistant message is still streaming in. */
  streaming?: boolean;
}

interface AssistantValue {
  msgs: AssistantMsg[];
  busy: boolean;
  error: string | null;
  send: (text: string) => Promise<void>;
  /** Abandon the turn in flight. The server sees the stream drop and stops the
   * model too, keeping whatever it had already written and done. */
  stop: () => void;
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
  const inflight = useRef<AbortController | null>(null);

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
    // The user message plus an empty assistant placeholder we stream into.
    setMsgs((m) => [...m, { role: "user", content: t }, { role: "assistant", content: "", steps: [], streaming: true }]);
    setBusy(true);
    // Patch the last (assistant) message as events arrive.
    const patchLast = (fn: (a: AssistantMsg) => AssistantMsg) =>
      setMsgs((m) => m.map((x, i) => (i === m.length - 1 ? fn(x) : x)));

    try {
      const ctrl = new AbortController();
      inflight.current = ctrl;
      const res = await fetch(`${apiBase}/assistant/chat`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "x-client-id": CLIENT_ID },
        body: JSON.stringify({ message: t }),
        signal: ctrl.signal,
      });
      if (res.status === 400) throw new ApiError(400, (await res.json().catch(() => ({})))?.error ?? "bad request");
      if (!res.ok || !res.body) throw new ApiError(res.status, "The assistant is unavailable.");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let live = ""; // reply text since the last tool step
      const apply = (ev: { type: string; text?: string; step?: AgentStep; reply?: string; steps?: AgentStep[]; pending?: PendingCall[]; message?: string }) => {
        if (ev.type === "token") {
          live += ev.text ?? "";
          patchLast((a) => ({ ...a, content: live }));
        } else if (ev.type === "step") {
          live = ""; // reply text restarts after a tool runs
          patchLast((a) => ({ ...a, steps: [...(a.steps ?? []), ev.step!], content: "" }));
        } else if (ev.type === "done") {
          patchLast((a) => ({ ...a, content: ev.reply ?? a.content, steps: ev.steps ?? a.steps, pending: ev.pending, streaming: false }));
        } else if (ev.type === "error") {
          setError(ev.message ?? "The assistant is unavailable.");
          patchLast((a) => ({ ...a, streaming: false }));
        }
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          try {
            apply(JSON.parse(dataLine.slice(5).trim()));
          } catch {
            /* skip malformed frame */
          }
        }
      }
      patchLast((a) => ({ ...a, streaming: false }));
    } catch (e) {
      // Stopping isn't a failure: the turn ends where it ends, and the server
      // has already kept the part that happened.
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setError(e instanceof ApiError ? e.message.replace(/^API \d+:?\s*/, "") : "The assistant is unavailable.");
      }
      patchLast((a) => ({ ...a, streaming: false }));
    } finally {
      inflight.current = null;
      setBusy(false);
    }
  };

  const stop = () => {
    inflight.current?.abort();
    inflight.current = null;
  };

  const resolvePending = async (idx: number, approve: boolean) => {
    const pending = msgs[idx]?.pending;
    if (!pending) return;
    setMsgs((m) => m.map((x, i) => (i === idx ? { ...x, resolved: true } : x)));
    if (!approve) {
      setMsgs((m) => [...m, { role: "assistant", content: "Okay — canceled, nothing was deleted." }]);
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
    <Ctx.Provider value={{ msgs, busy, error, send, stop, resolvePending, clear }}>{children}</Ctx.Provider>
  );
}

export function useAssistant(): AssistantValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAssistant must be used within AssistantProvider");
  return v;
}
