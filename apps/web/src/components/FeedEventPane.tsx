import { CalendarDays, Copy, MapPin, RefreshCw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { api, type FeedEvent } from "../api.ts";
import { emitCalendarRefresh, emitFeedEventConverted } from "../lib/calendar-events.ts";
import { usePanels } from "../lib/right-panel.tsx";

const fmtDateTime = (v: string, allDay: boolean) => {
  const d = new Date(allDay ? `${v}T00:00` : v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(allDay ? {} : { hour: "numeric", minute: "2-digit" }),
  });
};

/** Decode the common HTML entities that show up in feed descriptions. */
function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  };
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (full, code: string) => {
    if (code[0] === "#") {
      const n = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : full;
    }
    return named[code.toLowerCase()] ?? full;
  });
}

/**
 * Render a feed event's description as safe React nodes: flatten any HTML to
 * text (preserving anchor targets and line breaks) and linkify bare URLs. Feed
 * content is untrusted, so nothing is injected as raw HTML.
 */
function renderDescription(raw: string): ReactNode[] {
  let text = raw
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, (_full, href: string, label: string) => {
      const l = label.replace(/<[^>]+>/g, "").trim();
      return l && l !== href ? `${l} (${href})` : href;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "• ")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  text = decodeEntities(text).replace(/\n{3,}/g, "\n\n").trim();

  const parts: ReactNode[] = [];
  const re = /(https?:\/\/[^\s<]+[^\s<.,)!?])|(www\.[^\s<]+[^\s<.,)!?])/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const url = m[0];
    const href = url.startsWith("http") ? url : `https://${url}`;
    parts.push(
      <a key={i++} href={href} target="_blank" rel="noreferrer noopener">
        {url}
      </a>,
    );
    last = m.index + url.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/**
 * Read-only detail for a subscribed calendar-feed event. Feed events aren't
 * Hermes blocks; the only mutations offered are turning one into a Hermes event
 * — either "sync" (linked, follows the feed, hides the event here) or "copy"
 * (a one-off; the feed event stays).
 */
export function FeedEventPane({
  event,
  onConverted,
}: {
  event: FeedEvent;
  onConverted: (blockId: string) => void;
}) {
  const { selectBlock } = usePanels();
  const [busy, setBusy] = useState<"sync" | "copy" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const when =
    event.end && event.end !== event.start
      ? `${fmtDateTime(event.start, event.allDay)} → ${fmtDateTime(event.end, event.allDay)}`
      : fmtDateTime(event.start, event.allDay);

  const convert = async (mode: "sync" | "copy") => {
    setBusy(mode);
    setErr(null);
    try {
      const res = await api.post<{ blockId: string }>("/calendar/convert", {
        feedId: event.feedId,
        uid: event.uid,
        mode,
        summary: event.summary,
        description: event.description,
        location: event.location,
        start: event.start,
        end: event.end,
        allDay: event.allDay,
      });
      if (mode === "sync") emitFeedEventConverted(event.feedId, event.uid);
      else emitCalendarRefresh();
      onConverted(res.blockId);
      selectBlock(res.blockId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't convert this event");
      setBusy(null);
    }
  };

  return (
    <div className="info-pane feed-event-pane">
      <div className="feed-event-head">
        <span className="feed-event-dot" style={{ background: event.color }} />
        <h2 className="feed-event-title">{event.summary || "(untitled event)"}</h2>
      </div>

      <div className="feed-event-meta">
        <span className="feed-event-row">
          <CalendarDays size={14} />
          <span>{when}</span>
        </span>
        {event.location && (
          <span className="feed-event-row">
            <MapPin size={14} />
            <span>{event.location}</span>
          </span>
        )}
        <span className="feed-event-source">from {event.feedName}</span>
      </div>

      {event.description && (
        <p className="feed-event-desc">{renderDescription(event.description)}</p>
      )}

      <div className="feed-event-actions">
        <button className="primary feed-event-convert" onClick={() => void convert("sync")} disabled={busy !== null}>
          <RefreshCw size={15} />
          {busy === "sync" ? "Syncing…" : "Sync to Hermes event"}
        </button>
        <button className="ghost feed-event-copy" onClick={() => void convert("copy")} disabled={busy !== null}>
          <Copy size={15} />
          {busy === "copy" ? "Copying…" : "Make a copy"}
        </button>
      </div>
      <p className="hint feed-event-convert-hint">
        <strong>Sync</strong> keeps the Hermes event in step with this feed and hides it here — delete the
        event to bring it back. <strong>Copy</strong> is a one-off and leaves the feed event in place.
      </p>
      {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
    </div>
  );
}
