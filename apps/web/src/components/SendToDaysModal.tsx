import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api.ts";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayLabel = (key: string) =>
  new Date(`${key}T00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/**
 * Pick the days a piece of text should land on.
 *
 * A month at a time, days toggle, and the days already chosen are listed under
 * it — a run of Tuesdays picked across three months is otherwise a claim you
 * can't check without paging back through them.
 *
 * The day the text is being sent from is not selectable: it's already there.
 */
export function SendToDaysModal({
  text,
  from,
  onClose,
  onSent,
}: {
  /** The markdown being sent — shown back, so it's clear what's travelling. */
  text: string;
  /** The date of the note it's being sent from (YYYY-MM-DD). */
  from: string;
  onClose: () => void;
  onSent: (days: string[]) => void;
}) {
  const seed = new Date(`${from}T00:00`);
  const [view, setView] = useState({ y: seed.getFullYear(), m: seed.getMonth() });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const today = ymd(new Date());
  const first = new Date(view.y, view.m, 1);
  const gridStart = new Date(view.y, view.m, 1 - first.getDay());
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    return { key: ymd(d), day: d.getDate(), inMonth: d.getMonth() === view.m };
  });
  const stepMonth = (dir: -1 | 1) => {
    const d = new Date(view.y, view.m + dir, 1);
    setView({ y: d.getFullYear(), m: d.getMonth() });
  };
  const toggle = (key: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const chosen = [...picked].sort();
  const send = async () => {
    if (!chosen.length || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const r = await api.post<{ sent: string[] }>("/today/send", { text, from, dates: chosen });
      onSent(r.sent);
      onClose();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card send-days" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Send this text to…</h2>
        <p className="send-days-text">{text}</p>

        <div className="dtp-cal-head">
          <button className="icon-btn" title="Previous month" onClick={() => stepMonth(-1)}>
            <ChevronLeft size={16} />
          </button>
          <span className="dtp-month">
            {MONTHS[view.m]} {view.y}
          </span>
          <button className="icon-btn" title="Next month" onClick={() => stepMonth(1)}>
            <ChevronRight size={16} />
          </button>
        </div>
        <div className="dtp-grid dtp-dow">
          {WEEKDAYS.map((w, i) => (
            <span key={i} className="dtp-dow-cell">
              {w}
            </span>
          ))}
        </div>
        <div className="dtp-grid">
          {cells.map((c) => (
            <button
              key={c.key}
              className={
                "dtp-day" +
                (c.inMonth ? "" : " out") +
                (picked.has(c.key) ? " sel" : "") +
                (c.key === today ? " today" : "")
              }
              disabled={c.key === from}
              title={c.key === from ? "This is the day it's being sent from" : undefined}
              onClick={() => toggle(c.key)}
            >
              {c.day}
            </button>
          ))}
        </div>

        <div className="send-days-picked">
          {chosen.length === 0 ? (
            <span className="hint">No days chosen yet.</span>
          ) : (
            chosen.map((d) => (
              <button key={d} className="tag-chip" title="Remove" onClick={() => toggle(d)}>
                {dayLabel(d)} ✕
              </button>
            ))
          )}
        </div>
        {failed && <div className="error">Couldn’t send it. Try again.</div>}

        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={!chosen.length || busy} onClick={() => void send()}>
            {busy ? "Sending…" : `Send to ${chosen.length || ""} ${chosen.length === 1 ? "day" : "days"}`.trim()}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
