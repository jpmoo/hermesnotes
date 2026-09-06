/*
 * The canvas's own chat, and only the canvas's.
 *
 * Talaria's, not a fork: Hermes has no equivalent, and the Mac's reasoning for
 * having one is the whole design — "this one runs on the user's own inference
 * server against tools that do nothing but draw, so a canvas can be arranged
 * with no network beyond this machine."
 *
 * **The difference has to be visible**, because both chats can be open at once:
 * this drawer, and the Hermes assistant summoned over the top of it. Two chat
 * boxes that look alike are two chat boxes somebody types the wrong thing into.
 * So this one says what it does *not* do, in its empty state and in its
 * placeholder, and wears a pencil where the other wears wings.
 *
 * It also answers the question that made a canvas chat necessary rather than
 * nice: asked to "add everything from my one-offs project to this canvas", a
 * general assistant has to work out which canvas — a canvas collection in
 * Hermes, or this surface, which Hermes has never heard of. This one cannot be
 * confused, because drawing here is the only thing its tools can do. The daemon
 * gives it `canvas_add`, `canvas_add_blocks`, `canvas_connect`, `canvas_group`,
 * `canvas_restyle`, `canvas_remove`, and two read-only ways to look things up in
 * the library.
 */
import { useEffect, useRef, useState } from "react";
import { Pencil, X } from "lucide-react";
import { ask } from "../api.ts";

interface Step {
  tool: string;
  ok?: boolean;
  result?: string;
}

interface Turn {
  mine: boolean;
  text: string;
  steps?: Step[];
}

/** The Mac's four, verbatim: they say the shape of what it can do. */
const EXAMPLES = [
  "Add a node for each step of the release",
  "Make the orange ones circles",
  "Group these three and call it Blockers",
  "Find my 1Offs tasks and put them on here",
];

export function CanvasChat({ onDrawn }: { onDrawn: () => void }) {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [turns, busy]);
  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);

  async function send() {
    const message = draft.trim();
    if (!message || busy) return;
    setDraft("");
    setTrouble(null);
    // The history goes with it, so "make those ones circles" has a "those".
    const history = turns.map((t) => ({ role: t.mine ? "user" : "assistant", content: t.text }));
    setTurns((was) => [...was, { mine: true, text: message }]);
    setBusy(true);
    try {
      const turn = await ask<{ reply?: string; steps?: Step[] }>("POST", "/canvas/chat", {
        message,
        history,
      });
      setTurns((was) => [...was, { mine: false, text: turn.reply || "(nothing to say)", steps: turn.steps }]);
      // It drew on the document, so the document is read again. Every tool it
      // has writes `canvas.json`; nothing it does is visible until this.
      onDrawn();
    } catch (err) {
      setTrouble(String((err as Error).message || err));
    } finally {
      setBusy(false);
      field.current?.focus();
    }
  }

  if (!open) {
    return (
      <button className="chat-tab" title="Draw on this canvas" onClick={() => setOpen(true)}>
        <Pencil size={14} />
      </button>
    );
  }

  return (
    <aside className="chat-drawer">
      <header>
        <Pencil size={13} />
        <span>Draw</span>
        <button className="icon-btn" title="Close" onClick={() => setOpen(false)}>
          <X size={13} />
        </button>
      </header>

      <div className="chat-log" ref={log}>
        {!turns.length && !trouble && (
          <div className="chat-empty">
            <p className="chat-what">This draws on the canvas. Nothing else.</p>
            {EXAMPLES.map((example) => (
              <button key={example} className="chat-example" onClick={() => { setDraft(example); field.current?.focus(); }}>
                <span className="arrow">↳</span>
                <span>{example}</span>
              </button>
            ))}
            <p className="chat-fine">
              It can look things up in Hermes Notes to put them here, and it cannot change anything
              there — no new tasks, no completing, no renaming. The Hermes assistant does that.
            </p>
          </div>
        )}

        {turns.map((turn, i) => (
          <div key={i} className={"chat-turn" + (turn.mine ? " mine" : "")}>
            <div className="chat-bubble">{turn.text}</div>
            {turn.steps?.length ? (
              <div className="chat-steps">
                {turn.steps.map((step, j) => (
                  <span key={j} className={"chat-chip" + (step.ok === false ? " bad" : "")} title={step.result}>
                    {step.tool}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ))}

        {busy && <div className="chat-busy">drawing…</div>}
        {trouble && <div className="chat-trouble">{trouble}</div>}
      </div>

      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={field}
          rows={2}
          value={draft}
          placeholder="Draw something here…"
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; the canvas is not a place for paragraphs.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
            // The canvas listens for keys everywhere — Delete removes a node —
            // so nothing typed in here may reach it.
            e.stopPropagation();
          }}
        />
        <button className="go" disabled={busy || !draft.trim()} title="Send">→</button>
      </form>
    </aside>
  );
}
