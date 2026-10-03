import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
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
  /** The discussion being shown — a canvas bubble's thread — or null for the
   * panel's own conversation. */
  thread: ThreadInfo | null;
  /** Show a discussion (or, with null, the panel's own conversation) and bring
   * the AI tab forward. */
  openThread: (id: string | null) => void;
  /** Bumped by `openThread`; the right panel follows it to the AI tab. */
  openTick: number;
  /** Titles discussions have taken from their first question, by thread id —
   * so a bubble on a canvas can label itself without asking the server. */
  titles: Record<string, string>;
}

export interface ThreadInfo {
  id: string;
  collectionId: string | null;
  anchorId: string | null;
  noteId: string | null;
  title: string;
}

const Ctx = createContext<AssistantValue | null>(null);

/**
 * The assistant changed a canvas — tell any canvas on screen to read itself
 * again.
 *
 * A canvas reads its notes and connections once, when it opens, and saves them
 * by replacing the whole list. So a note the assistant added was invisible
 * until a reload, and the next thing you moved wrote the old list back over
 * it — the note was gone before you ever saw it. Announced per tool step, not
 * at the end of the turn, so the window in which an edit of yours can clobber
 * the assistant's is one step wide rather than one turn.
 */
export const CANVAS_CHANGED = "hermes:canvas-changed";
const touchesCanvas = (tool: string) =>
  tool.startsWith("canvas_") || tool === "collection_add" || tool === "collection_remove";
const announceCanvasChange = () => window.dispatchEvent(new Event(CANVAS_CHANGED));

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
  const [thread, setThread] = useState<ThreadInfo | null>(null);
  const [openTick, setOpenTick] = useState(0);
  const [titles, setTitles] = useState<Record<string, string>>({});
  /**
   * Which thread the panel is showing *now*, for code that outlives a render.
   *
   * A turn streams for seconds. If somebody opens another bubble meanwhile, the
   * tokens still arriving belong to the thread they were asked in — patching
   * them into whatever list is on screen would write one discussion's answer
   * into another. The server keeps the turn either way; this only decides
   * whether it is drawn.
   */
  const shown = useRef<string | null>(null);
  /**
   * The collection on screen, if the page is one — sent with every message so
   * "add this", "put it here" and "this canvas" mean the one being looked at.
   * Without it the panel's assistant had no idea, and an "add" became a new
   * canvas somewhere else.
   */
  const { pathname } = useLocation();
  const viewing = /^\/collections\/([0-9a-f-]{36})/i.exec(pathname)?.[1];
  const q = (id: string | null) => (id ? `?threadId=${encodeURIComponent(id)}` : "");

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void api
      .get<{ messages: AssistantMsg[] }>("/assistant/messages")
      .then((d) => setMsgs(d.messages))
      .catch(() => {});
  }, []);

  const openThread = (id: string | null) => {
    setOpenTick((t) => t + 1);
    // Already showing it: bring the panel forward and leave the conversation
    // alone. Clicking a cloud whose discussion is open would otherwise empty
    // and refill it — a flash, and a turn mid-stream drawn over by its own
    // history.
    if (id === shown.current) return;
    shown.current = id;
    setError(null);
    setMsgs([]);
    if (!id) {
      setThread(null);
      void api
        .get<{ messages: AssistantMsg[] }>("/assistant/messages")
        .then((d) => shown.current === null && setMsgs(d.messages))
        .catch(() => {});
      return;
    }
    setThread({ id, collectionId: null, anchorId: null, noteId: null, title: titles[id] ?? "" });
    void api
      .get<ThreadInfo>(`/assistant/threads/${id}`)
      .then((t) => shown.current === id && setThread(t))
      .catch(() => {});
    void api
      .get<{ messages: AssistantMsg[] }>(`/assistant/messages${q(id)}`)
      .then((d) => shown.current === id && setMsgs(d.messages))
      .catch((e) => shown.current === id && setError(e instanceof ApiError ? "That discussion is gone." : null));
  };

  const send = async (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    setError(null);
    // The user message plus an empty assistant placeholder we stream into.
    setMsgs((m) => [...m, { role: "user", content: t }, { role: "assistant", content: "", steps: [], streaming: true }]);
    setBusy(true);
    // Patch the last (assistant) message as events arrive — while this
    // thread is still the one on screen; see `shown`.
    const asked = shown.current;
    const patchLast = (fn: (a: AssistantMsg) => AssistantMsg) => {
      if (shown.current !== asked) return;
      setMsgs((m) => m.map((x, i) => (i === m.length - 1 ? fn(x) : x)));
    };

    try {
      const ctrl = new AbortController();
      inflight.current = ctrl;
      const res = await fetch(`${apiBase}/assistant/chat`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "x-client-id": CLIENT_ID },
        body: JSON.stringify({
          message: t,
          ...(asked ? { threadId: asked } : {}),
          ...(viewing ? { viewing } : {}),
        }),
        signal: ctrl.signal,
      });
      if (res.status === 400) throw new ApiError(400, (await res.json().catch(() => ({})))?.error ?? "bad request");
      if (!res.ok || !res.body) throw new ApiError(res.status, "The assistant is unavailable.");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let live = ""; // reply text since the last tool step
      const apply = (ev: { type: string; text?: string; step?: AgentStep; reply?: string; steps?: AgentStep[]; pending?: PendingCall[]; message?: string; title?: string }) => {
        // The discussion took its name from this question: the bubble that
        // holds it can say so, whichever thread is on screen by now.
        if (ev.type === "done" && ev.title && asked) {
          setTitles((all) => ({ ...all, [asked]: ev.title! }));
          if (shown.current === asked) setThread((th) => (th ? { ...th, title: ev.title! } : th));
        }
        if (ev.type === "token") {
          live += ev.text ?? "";
          patchLast((a) => ({ ...a, content: live }));
        } else if (ev.type === "step") {
          live = ""; // reply text restarts after a tool runs
          if (ev.step && touchesCanvas(ev.step.tool)) announceCanvasChange();
          patchLast((a) => ({ ...a, steps: [...(a.steps ?? []), ev.step!], content: "" }));
        } else if (ev.type === "done") {
          patchLast((a) => ({ ...a, content: ev.reply ?? a.content, steps: ev.steps ?? a.steps, pending: ev.pending, streaming: false }));
        } else if (ev.type === "error") {
          if (shown.current === asked) setError(ev.message ?? "The assistant is unavailable.");
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
      const res = await api.post<{ steps: AgentStep[] }>("/assistant/confirm", {
        calls: pending,
        ...(shown.current ? { threadId: shown.current } : {}),
      });
      setMsgs((m) => [...m, { role: "assistant", content: "Done.", steps: res.steps }]);
      if (res.steps.some((st) => touchesCanvas(st.tool))) announceCanvasChange();
    } catch (e) {
      setError(e instanceof ApiError ? e.message.replace(/^API \d+:?\s*/, "") : "Couldn't complete that.");
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    await api.del(`/assistant/messages${q(shown.current)}`).catch(() => {});
    setMsgs([]);
    setError(null);
  };

  return (
    <Ctx.Provider
      value={{ msgs, busy, error, send, stop, resolvePending, clear, thread, openThread, openTick, titles }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useAssistant(): AssistantValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAssistant must be used within AssistantProvider");
  return v;
}
