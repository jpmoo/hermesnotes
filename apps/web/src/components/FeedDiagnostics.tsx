import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api, type CalendarFeed } from "../api.ts";

const when = (iso: string | null) => {
  if (!iso) return "never";
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  const ago =
    mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`;
  return `${d.toLocaleString()} (${ago})`;
};

/**
 * Why a subscribed calendar isn't updating. A feed that fails does so on someone
 * else's server, so the only useful thing we can do is show exactly what came
 * back — status, message, whatever the host said — and what usually fixes it.
 */
export function FeedDiagnostics({ feed, onClose, onChanged }: {
  feed: CalendarFeed;
  onClose: () => void;
  onChanged?: (feed: CalendarFeed) => void;
}) {
  const [current, setCurrent] = useState(feed);
  const [busy, setBusy] = useState(false);
  useEffect(() => setCurrent(feed), [feed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /**
   * Fetch it again for real. If that fixed it there's nothing left to say, so
   * this closes and hands the user back to whatever they were looking at; if it
   * failed again the dialog stays put, now showing what went wrong this time.
   */
  const retry = async () => {
    setBusy(true);
    try {
      const next = await api.post<CalendarFeed>(`/calendar/feeds/${current.id}/refresh`, {});
      setCurrent(next);
      onChanged?.(next);
      if (!next.lastError) onClose();
    } catch {
      /* the row itself carries the outcome; a failed call leaves it as it was */
    } finally {
      setBusy(false);
    }
  };

  const failing = Boolean(current.lastError);
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card feed-diag" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">
          {failing ? <AlertTriangle size={16} className="feed-diag-bad" /> : <CheckCircle2 size={16} className="feed-diag-ok" />}
          <span style={{ color: current.color }}>{current.name}</span>
        </h2>

        {failing ? (
          <>
            <p className="feed-diag-headline">
              {current.lastStatus ? `HTTP ${current.lastStatus} — ` : ""}
              {current.lastError}
            </p>
            {current.lastDetail && <p className="modal-message feed-diag-detail">{current.lastDetail}</p>}
          </>
        ) : (
          <p className="modal-message">This calendar is being read without trouble.</p>
        )}

        <dl className="feed-diag-facts">
          <dt>Address</dt>
          <dd className="feed-diag-url">{current.url}</dd>
          <dt>Last read</dt>
          <dd>{when(current.lastFetchedAt)}</dd>
          <dt>Showing a copy from</dt>
          <dd>{when(current.cachedAt)}</dd>
          {failing && (
            <>
              <dt>Failing since</dt>
              <dd>{when(current.lastErrorAt)}</dd>
            </>
          )}
        </dl>

        <p className="hint feed-diag-note">
          Calendars refresh in the background every few minutes. Events shown come from the
          last copy read successfully, so they stay on screen even while a refresh is failing.
        </p>

        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>
            Close
          </button>
          <button className="primary" disabled={busy} onClick={() => void retry()}>
            <RefreshCw size={14} className={busy ? "hn-spin" : undefined} /> {busy ? "Trying…" : "Try again now"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
