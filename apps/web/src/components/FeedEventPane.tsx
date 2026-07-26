import { CalendarDays, CalendarPlus, MapPin } from "lucide-react";
import { useState } from "react";
import { api, type FeedEvent } from "../api.ts";
import { emitFeedEventConverted } from "../lib/calendar-events.ts";
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

/**
 * Read-only detail for a subscribed calendar-feed event, shown in the info
 * panel. Feed events aren't Hermes blocks — the only mutation offered is
 * "convert to a happening", which creates an event block and thereafter hides
 * this event from the feed.
 */
export function FeedEventPane({
  event,
  onConverted,
}: {
  event: FeedEvent;
  onConverted: (blockId: string) => void;
}) {
  const { openBlock } = usePanels();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const when =
    event.end && event.end !== event.start
      ? `${fmtDateTime(event.start, event.allDay)} → ${fmtDateTime(event.end, event.allDay)}`
      : fmtDateTime(event.start, event.allDay);

  const convert = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await api.post<{ blockId: string }>("/calendar/convert", {
        feedId: event.feedId,
        uid: event.uid,
        summary: event.summary,
        description: event.description,
        location: event.location,
        start: event.start,
        end: event.end,
        allDay: event.allDay,
      });
      emitFeedEventConverted(event.feedId, event.uid);
      onConverted(res.blockId);
      openBlock(res.blockId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't convert this event");
      setBusy(false);
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

      {event.description && <p className="feed-event-desc">{event.description}</p>}

      <button className="primary feed-event-convert" onClick={() => void convert()} disabled={busy}>
        <CalendarPlus size={15} />
        {busy ? "Converting…" : "Convert to a happening"}
      </button>
      <p className="hint feed-event-convert-hint">
        Creates an event block in Hermes and removes this from the feed.
      </p>
      {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
    </div>
  );
}
