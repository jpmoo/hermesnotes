import { AlertTriangle, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type CalendarFeed } from "../api.ts";

const SWATCHES = [
  "#6b7cff", "#e6584d", "#f5a623", "#3fb950", "#22b8cf",
  "#a970ff", "#ec4899", "#8b9199",
];

/** Settings card: subscribe to external calendar URLs (ICS from Google, Outlook,
 * iCloud, etc.). Events show read-only on calendar views, colored per feed. */
export function CalendarFeedsSettings() {
  const [feeds, setFeeds] = useState<CalendarFeed[]>([]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [color, setColor] = useState(SWATCHES[0]!);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    void api
      .get<CalendarFeed[]>("/calendar/feeds")
      .then(setFeeds)
      .catch(() => setFeeds([]));
  };
  useEffect(load, []);

  const add = async () => {
    if (!name.trim() || !url.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const feed = await api.post<CalendarFeed>("/calendar/feeds", {
        name: name.trim(),
        url: url.trim(),
        color,
      });
      setFeeds((f) => [...f, feed]);
      setName("");
      setUrl("");
      setColor(SWATCHES[0]!);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't add that calendar");
    } finally {
      setBusy(false);
    }
  };

  const patch = (id: string, body: Partial<Pick<CalendarFeed, "color" | "enabled" | "name">>) => {
    setFeeds((f) => f.map((x) => (x.id === id ? { ...x, ...body } : x)));
    void api.patch(`/calendar/feeds/${id}`, body).catch(load);
  };

  const remove = (id: string) => {
    setFeeds((f) => f.filter((x) => x.id !== id));
    void api.del(`/calendar/feeds/${id}`).catch(load);
  };

  return (
    <div className="card">
      <h2 className="chrome" style={{ margin: "0 0 4px", fontSize: 15 }}>
        Calendar feeds
      </h2>
      <p className="hint" style={{ marginBottom: 14 }}>
        Subscribe to external calendars (Google, Outlook, iCloud…) by their public
        ICS/secret address. Events appear read-only on calendar views; convert one
        into a Hermes event from its detail panel.
      </p>

      {feeds.length > 0 && (
        <div className="cal-feed-list">
          {feeds.map((feed) => (
            <div key={feed.id} className="cal-feed-row">
              <input
                type="checkbox"
                checked={feed.enabled}
                title={feed.enabled ? "Shown on calendars" : "Hidden"}
                onChange={(e) => patch(feed.id, { enabled: e.target.checked })}
              />
              <span className="cal-feed-swatches">
                {SWATCHES.map((c) => (
                  <button
                    key={c}
                    className={`cal-feed-swatch${feed.color === c ? " active" : ""}`}
                    style={{ background: c }}
                    title="Set color"
                    onClick={() => patch(feed.id, { color: c })}
                  />
                ))}
              </span>
              <span className="cal-feed-info">
                <span className="cal-feed-name" style={{ color: feed.color }}>
                  {feed.name}
                </span>
                <span className="cal-feed-url">{feed.url}</span>
                {feed.lastError && (
                  <span className="cal-feed-error">
                    <AlertTriangle size={12} /> {feed.lastError}
                  </span>
                )}
              </span>
              <button className="icon-btn" title="Remove" onClick={() => remove(feed.id)}>
                <X size={15} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="cal-feed-add">
        <div className="cal-feed-add-fields">
          <input
            className="input"
            placeholder="Name (e.g. Work, Family)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="input"
            placeholder="Calendar URL (https://… .ics or webcal://…)"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <div className="cal-feed-add-controls">
          <span className="cal-feed-swatches">
            {SWATCHES.map((c) => (
              <button
                key={c}
                className={`cal-feed-swatch${color === c ? " active" : ""}`}
                style={{ background: c }}
                title="Color"
                onClick={() => setColor(c)}
              />
            ))}
          </span>
          <button className="primary" onClick={() => void add()} disabled={busy || !name.trim() || !url.trim()}>
            <Plus size={15} /> {busy ? "Adding…" : "Add calendar"}
          </button>
        </div>
      </div>
      {err && <div className="error" style={{ marginTop: 10 }}>{err}</div>}
    </div>
  );
}
