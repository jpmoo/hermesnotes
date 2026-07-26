import type { FieldDef, PropertySchema } from "@hermes/shared";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Block, type BlockType, type CalendarFeed, type Collection, type FeedEvent, type Member } from "../api.ts";
import { useBlockDeleted } from "../lib/block-events.ts";
import { useCalendarRefresh, useFeedEventConverted } from "../lib/calendar-events.ts";
import { isOverdue, oneLineText } from "../lib/display.ts";
import { normalizeFilter } from "../lib/filter.ts";
import { BlockIcon } from "../lib/icons.tsx";
import { usePanels } from "../lib/right-panel.tsx";

/**
 * Calendar collection: a month / week / 3-day date view. Smart-query fed —
 * matching cards land on the days their date/datespan fields point to (same
 * placement logic as a matrix in date mode). Dates are read-only here; you
 * reschedule by editing the card. The status chip stays interactive.
 */

type ViewMode = "month" | "week" | "day3";
const VIEWS: { key: ViewMode; label: string }[] = [
  { key: "month", label: "Month" },
  { key: "week", label: "Week" },
  { key: "day3", label: "3-day" },
];

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const pretty = (v: string) => v.replace(/_/g, " ");
const fmtShort = (v: string) => {
  const d = new Date(v.includes("T") ? v : `${v}T00:00`);
  return Number.isNaN(d.getTime())
    ? v
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

interface DateBit {
  text: string;
  overdue: boolean;
}

/** Every day (YYYY-MM-DD) a block's date/datespan fields land on. */
function occupiedDays(schema: PropertySchema | null | undefined, props: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  for (const f of schema?.fields ?? []) {
    const v = props[f.key];
    if (v == null || v === "") continue;
    if (f.type === "datetime" || f.type === "date") {
      out.add(String(v).slice(0, 10));
    } else if (f.type === "datespan" && typeof v === "object") {
      const span = v as { start?: string; end?: string };
      const s = span.start?.slice(0, 10) || "";
      const e = span.end?.slice(0, 10) || "";
      if (s && e && e >= s) {
        const d = new Date(`${s}T00:00`);
        for (let i = 0; i < 366; i++) {
          const k = ymd(d);
          out.add(k);
          if (k === e) break;
          d.setDate(d.getDate() + 1);
        }
      } else if (s || e) out.add(s || e);
    }
  }
  return out;
}

/** Short display strings for any dated fields (with overdue flagging). */
function dateBits(schema: PropertySchema | null | undefined, props: Record<string, unknown>): DateBit[] {
  const statusKey = schema?.status_field;
  const done = statusKey ? (schema?.complete_values ?? []).includes(String(props[statusKey] ?? "")) : false;
  const out: DateBit[] = [];
  for (const f of schema?.fields ?? []) {
    const v = props[f.key];
    if (v == null || v === "") continue;
    if (f.type === "datetime" || f.type === "date") {
      out.push({ text: fmtShort(String(v)), overdue: false });
    } else if (f.type === "datespan" && typeof v === "object") {
      const span = v as { start?: string; end?: string };
      const s = span.start ? fmtShort(span.start) : "";
      const e = span.end ? fmtShort(span.end) : "";
      if (s || e) out.push({ text: s && e ? `${s} – ${e}` : s || e, overdue: !done && isOverdue(span.end) });
    }
  }
  return out;
}

function statusFieldOf(type: BlockType | undefined): FieldDef | null {
  const schema = type?.propertySchema;
  const key = schema?.status_field;
  return schema?.fields.find((f) => f.type === "status" && f.key === key) ?? null;
}

interface Item {
  id: string;
  blockTypeId: string | null;
  label: string;
  props: Record<string, unknown>;
  version: number;
}

function Chip({
  item,
  types,
  onStatus,
}: {
  item: Item;
  types: BlockType[];
  onStatus: (item: Item, field: FieldDef, next: string) => void;
}) {
  const { selectBlock } = usePanels();
  const t = item.blockTypeId ? types.find((x) => x.id === item.blockTypeId) : undefined;
  const statusField = statusFieldOf(t);
  const status = statusField ? String(item.props[statusField.key] ?? "") : "";
  const dates = dateBits(t?.propertySchema ?? null, item.props);
  const cycle = () => {
    if (!statusField) return;
    const opts = statusField.options ?? [];
    if (!opts.length) return;
    const next = opts[(opts.indexOf(status) + 1) % opts.length];
    if (next) onStatus(item, statusField, next);
  };
  return (
    <div
      className="cal-chip"
      onClick={(e) => {
        e.stopPropagation();
        selectBlock(item.id);
      }}
    >
      {statusField ? (
        <button
          className="chip-status"
          title={status ? `Status: ${pretty(status)} — click to cycle` : "Set status"}
          onClick={(e) => {
            e.stopPropagation();
            cycle();
          }}
        >
          <BlockIcon
            iconKey={statusField.optionIcons?.[status] ?? t?.iconKey}
            color={statusField.optionColors?.[status] ?? t?.iconColor}
            size={13}
          />
        </button>
      ) : (
        <BlockIcon iconKey={!t || t.isText ? "type" : t.iconKey} color={t && !t.isText ? t.iconColor : null} size={12} />
      )}
      <span className="cal-chip-label">{item.label}</span>
      {dates.some((d) => d.overdue) && <span className="cal-chip-overdue" title="Overdue" />}
    </div>
  );
}

/** Days (YYYY-MM-DD) a feed event lands on, from its start through its end. */
function feedEventDays(ev: FeedEvent): string[] {
  const s = ev.start.slice(0, 10);
  const e = (ev.end ?? ev.start).slice(0, 10);
  if (!s) return [];
  if (e <= s) return [s];
  const out: string[] = [];
  const d = new Date(`${s}T00:00`);
  for (let i = 0; i < 366; i++) {
    const k = ymd(d);
    out.push(k);
    if (k === e) break;
    d.setDate(d.getDate() + 1);
  }
  return out;
}

const fmtTime = (v: string) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
};

/** A read-only calendar-feed event chip, colored by its feed. */
function FeedChip({ event }: { event: FeedEvent }) {
  const { selectFeedEvent } = usePanels();
  const time = event.allDay ? "" : fmtTime(event.start);
  return (
    <div
      className="cal-chip cal-feed-chip"
      style={{ ["--feed-color" as string]: event.color }}
      title={`${event.summary} — ${event.feedName}`}
      onClick={(e) => {
        e.stopPropagation();
        selectFeedEvent(event);
      }}
    >
      <span className="cal-feed-dot" style={{ background: event.color }} />
      {time && <span className="cal-feed-time">{time}</span>}
      <span className="cal-chip-label">{event.summary || "(untitled)"}</span>
    </div>
  );
}

// ── Week / 3-day time-band layout ───────────────────────────────
const HOUR_H = 46; // px per hour in the time grid
const minutesOf = (v: string) => {
  const d = new Date(v.includes("T") ? v : `${v}T00:00`);
  return Number.isNaN(d.getTime()) ? 0 : d.getHours() * 60 + d.getMinutes();
};
const hasTime = (v: unknown) => typeof v === "string" && v.includes("T");
const fmtHour = (h: number) => {
  const ampm = h < 12 ? "AM" : "PM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr} ${ampm}`;
};

interface Placement {
  day: string;
  allDay: boolean;
  startMin: number;
  endMin: number;
}

/** Where a block's dated fields land — per day, timed or all-day. */
function blockPlacements(schema: PropertySchema | null | undefined, props: Record<string, unknown>): Placement[] {
  const out: Placement[] = [];
  for (const f of schema?.fields ?? []) {
    const v = props[f.key];
    if (v == null || v === "") continue;
    if (f.type === "date") {
      out.push({ day: String(v).slice(0, 10), allDay: true, startMin: 0, endMin: 0 });
    } else if (f.type === "datetime") {
      const s = minutesOf(String(v));
      out.push({ day: String(v).slice(0, 10), allDay: false, startMin: s, endMin: s + 60 });
    } else if (f.type === "datespan" && typeof v === "object") {
      const span = v as { start?: string; end?: string };
      const sDay = span.start?.slice(0, 10) || "";
      const eDay = span.end?.slice(0, 10) || sDay;
      if (!sDay && !eDay) continue;
      if (eDay > sDay) {
        // Multi-day span: an all-day band on each covered day.
        const d = new Date(`${sDay}T00:00`);
        for (let i = 0; i < 366; i++) {
          const k = ymd(d);
          out.push({ day: k, allDay: true, startMin: 0, endMin: 0 });
          if (k === eDay) break;
          d.setDate(d.getDate() + 1);
        }
      } else if (hasTime(span.start)) {
        const s = minutesOf(span.start!);
        const e = span.end && hasTime(span.end) ? minutesOf(span.end) : s + 60;
        out.push({ day: sDay, allDay: false, startMin: s, endMin: Math.max(e, s + 15) });
      } else {
        out.push({ day: sDay || eDay, allDay: true, startMin: 0, endMin: 0 });
      }
    }
  }
  return out;
}

/** Where a feed event lands — timed on its day, or all-day (incl. multi-day). */
function feedPlacements(ev: FeedEvent): Placement[] {
  const sDay = ev.start.slice(0, 10);
  const eDay = (ev.end ?? ev.start).slice(0, 10);
  if (ev.allDay || eDay > sDay) {
    return feedEventDays(ev).map((day) => ({ day, allDay: true, startMin: 0, endMin: 0 }));
  }
  const s = minutesOf(ev.start);
  const e = ev.end ? minutesOf(ev.end) : s + 60;
  return [{ day: sDay, allDay: false, startMin: s, endMin: Math.max(e, s + 15) }];
}

type GridRef =
  | { kind: "block"; item: Item; key: string }
  | { kind: "feed"; event: FeedEvent; key: string };
interface TimedEntry {
  ref: GridRef;
  startMin: number;
  endMin: number;
  lane: number;
  lanes: number;
}

/** Greedy lane assignment so overlapping timed events sit side by side. */
function layoutLanes(entries: Omit<TimedEntry, "lane" | "lanes">[]): TimedEntry[] {
  const sorted = [...entries].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const out: TimedEntry[] = [];
  let cluster: TimedEntry[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const lanes = cluster.reduce((m, e) => Math.max(m, e.lane + 1), 0);
    for (const e of cluster) e.lanes = lanes;
    out.push(...cluster);
    cluster = [];
    clusterEnd = -1;
  };
  for (const e of sorted) {
    if (cluster.length && e.startMin >= clusterEnd) flush();
    // Running end per lane within the current cluster; reuse the first free one.
    const ends: number[] = [];
    for (const c of cluster) ends[c.lane] = Math.max(ends[c.lane] ?? 0, c.endMin);
    let lane = ends.findIndex((end) => end <= e.startMin);
    if (lane < 0) lane = ends.length;
    cluster.push({ ...e, lane, lanes: 1 });
    clusterEnd = Math.max(clusterEnd, e.endMin);
  }
  if (cluster.length) flush();
  return out;
}

export function CalendarView({
  collection,
  members,
  types,
  onChanged,
}: {
  collection: Collection;
  members: Member[];
  types: BlockType[];
  onChanged: () => void;
}) {
  const { selectBlock } = usePanels();
  const selectCollection = () => selectBlock(collection.id, { collection: true });
  const props = collection.properties;
  const isSmart = props.membership_mode === "smart";

  const [view, setView] = useState<ViewMode>(
    ((): ViewMode => {
      const v = props.calendar_view;
      return v === "week" || v === "day3" ? v : "month";
    })(),
  );
  useEffect(() => {
    const v = collection.properties.calendar_view;
    setView(v === "week" || v === "day3" ? v : "month");
  }, [collection.properties.calendar_view]);

  // Anchor date (today by default); prev/next steps by view size.
  const [anchor, setAnchor] = useState(() => ymd(new Date()));
  const [matches, setMatches] = useState<Block[]>([]);
  const [queryTick, setQueryTick] = useState(0);
  const [feedEvents, setFeedEvents] = useState<FeedEvent[]>([]);
  const [convertedKeys, setConvertedKeys] = useState<Set<string>>(new Set());
  const [feedTick, setFeedTick] = useState(0);
  const [feeds, setFeeds] = useState<CalendarFeed[]>([]);
  const hiddenKey = `hn.cal.hidden.${collection.id}`;
  const [hiddenFeeds, setHiddenFeeds] = useState<Set<string>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(hiddenKey) || "[]") as unknown;
      return new Set(Array.isArray(raw) ? (raw as string[]) : []);
    } catch {
      return new Set();
    }
  });
  const toggleFeed = (id: string) =>
    setHiddenFeeds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(hiddenKey, JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
      return next;
    });

  useEffect(() => {
    if (!isSmart) {
      setMatches([]);
      return;
    }
    let alive = true;
    void api
      .post<Block[]>("/blocks/query", { filterQuery: normalizeFilter(props.filter_query) })
      .then((r) => alive && setMatches(r))
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSmart, JSON.stringify(props.filter_query), collection.updatedAt, queryTick]);

  const setViewMode = (v: ViewMode) => {
    setView(v);
    selectCollection();
    void api.patch(`/collections/${collection.id}`, { calendar_view: v }).then(onChanged);
  };

  const today = ymd(new Date());
  const anchorDate = new Date(`${anchor}T00:00`);

  // Visible days for the current view.
  const days = useMemo<string[]>(() => {
    if (view === "day3") return [-1, 0, 1].map((n) => ymd(addDays(anchorDate, n)));
    if (view === "week") {
      const start = addDays(anchorDate, -anchorDate.getDay());
      return Array.from({ length: 7 }, (_, i) => ymd(addDays(start, i)));
    }
    // month: full weeks covering the anchor's month
    const first = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1);
    const gridStart = addDays(first, -first.getDay());
    return Array.from({ length: 42 }, (_, i) => ymd(addDays(gridStart, i)));
  }, [view, anchor]);

  const rangeStart = days[0]!;
  const rangeEnd = days[days.length - 1]!;

  // Subscribed calendar-feed events overlapping the visible range (read-only).
  useEffect(() => {
    let alive = true;
    void api
      .get<{ events: FeedEvent[] }>(`/calendar/events?start=${rangeStart}&end=${rangeEnd}`)
      .then((r) => alive && setFeedEvents(r.events))
      .catch(() => alive && setFeedEvents([]));
    return () => {
      alive = false;
    };
  }, [rangeStart, rangeEnd, feedTick]);

  // Subscribed feeds (for the show/hide toggles). Only enabled feeds produce
  // events, so those are the only ones worth toggling.
  useEffect(() => {
    let alive = true;
    void api
      .get<CalendarFeed[]>("/calendar/feeds")
      .then((r) => alive && setFeeds(r.filter((f) => f.enabled)))
      .catch(() => alive && setFeeds([]));
    return () => {
      alive = false;
    };
  }, [feedTick]);

  // A feed event synced from the info panel disappears from the feed: drop it
  // optimistically, then refetch feeds + block matches to reconcile (the new
  // Hermes event now shows as a normal block chip).
  useFeedEventConverted((feedId, uid) => {
    setConvertedKeys((prev) => new Set(prev).add(`${feedId}|${uid}`));
    setFeedTick((t) => t + 1);
    setQueryTick((t) => t + 1);
  });
  // A "copy" left the feed unchanged but added a block — refetch matches.
  useCalendarRefresh(() => setQueryTick((t) => t + 1));

  // A deleted block leaves the calendar at once. If it was a synced feed event,
  // deleting it dropped the link server-side, so refetch feeds to bring the
  // source event back (and drop any stale optimistic hide).
  useBlockDeleted((id) => {
    setMatches((ms) => ms.filter((b) => b.id !== id));
    setConvertedKeys(new Set());
    setFeedTick((t) => t + 1);
  });

  // Day → feed events landing on it (multi-day events span every covered day).
  const feedByDay = useMemo(() => {
    const visible = new Set(days);
    const map = new Map<string, FeedEvent[]>();
    for (const ev of feedEvents) {
      if (convertedKeys.has(`${ev.feedId}|${ev.uid}`)) continue;
      if (hiddenFeeds.has(ev.feedId)) continue;
      for (const d of feedEventDays(ev)) {
        if (!visible.has(d)) continue;
        map.set(d, [...(map.get(d) ?? []), ev]);
      }
    }
    return map;
  }, [feedEvents, convertedKeys, hiddenFeeds, days]);

  // Source blocks: smart → live query matches; else the explicit members.
  const source = useMemo<Item[]>(() => {
    const toItem = (b: { id: string; blockTypeId: string | null; properties: unknown; content?: string | null; version: number }): Item => ({
      id: b.id,
      blockTypeId: b.blockTypeId,
      label: oneLineText(b.properties as Record<string, unknown>, b.content) || "Untitled",
      props: (b.properties ?? {}) as Record<string, unknown>,
      version: b.version,
    });
    return (isSmart ? matches : members).map(toItem);
  }, [isSmart, matches, members]);

  const typeById = useMemo(() => new Map(types.map((t) => [t.id, t])), [types]);

  // Day → items landing on it.
  const byDay = useMemo(() => {
    const visible = new Set(days);
    const map = new Map<string, Item[]>();
    for (const it of source) {
      const schema = it.blockTypeId ? typeById.get(it.blockTypeId)?.propertySchema ?? null : null;
      for (const d of occupiedDays(schema, it.props)) {
        if (!visible.has(d)) continue;
        map.set(d, [...(map.get(d) ?? []), it]);
      }
    }
    return map;
  }, [source, days, typeById]);

  const patchStatus = (item: Item, field: FieldDef, next: string) => {
    const nextProps = { ...item.props, [field.key]: next };
    void api
      .patch(`/blocks/${item.id}`, { properties: nextProps, version: item.version })
      .catch(() => {})
      .then(() => {
        setMatches((ms) =>
          ms.map((b) => (b.id === item.id ? { ...b, properties: nextProps, version: (b.version ?? 0) + 1 } : b)),
        );
        setQueryTick((t) => t + 1);
        onChanged();
      });
  };
  const onStatus = (item: Item, field: FieldDef, next: string) => patchStatus(item, field, next);

  // Week / 3-day time-band data: per visible day, all-day refs + laid-out timed
  // entries (blocks and feed events together).
  const timeGrid = useMemo(() => {
    const visible = new Set(days);
    const perDay = new Map<string, { allDay: GridRef[]; timed: TimedEntry[] }>();
    const rawTimed = new Map<string, Omit<TimedEntry, "lane" | "lanes">[]>();
    for (const d of days) {
      perDay.set(d, { allDay: [], timed: [] });
      rawTimed.set(d, []);
    }
    for (const it of source) {
      const schema = it.blockTypeId ? typeById.get(it.blockTypeId)?.propertySchema ?? null : null;
      for (const p of blockPlacements(schema, it.props)) {
        if (!visible.has(p.day)) continue;
        const ref: GridRef = { kind: "block", item: it, key: `b:${it.id}:${p.day}:${p.startMin}` };
        if (p.allDay) perDay.get(p.day)!.allDay.push(ref);
        else rawTimed.get(p.day)!.push({ ref, startMin: p.startMin, endMin: p.endMin });
      }
    }
    for (const ev of feedEvents) {
      if (convertedKeys.has(`${ev.feedId}|${ev.uid}`)) continue;
      if (hiddenFeeds.has(ev.feedId)) continue;
      for (const p of feedPlacements(ev)) {
        if (!visible.has(p.day)) continue;
        const ref: GridRef = { kind: "feed", event: ev, key: `f:${ev.feedId}:${ev.uid}:${p.day}:${p.startMin}` };
        if (p.allDay) perDay.get(p.day)!.allDay.push(ref);
        else rawTimed.get(p.day)!.push({ ref, startMin: p.startMin, endMin: p.endMin });
      }
    }
    for (const d of days) perDay.get(d)!.timed = layoutLanes(rawTimed.get(d)!);
    return perDay;
  }, [source, feedEvents, convertedKeys, hiddenFeeds, days, typeById]);

  const scrollRef = useRef<HTMLDivElement>(null);
  // Open the time grid scrolled to the morning (7am) rather than midnight.
  useEffect(() => {
    if (view !== "month" && scrollRef.current) scrollRef.current.scrollTop = 7 * HOUR_H;
  }, [view, anchor]);

  const step = (dir: -1 | 1) => {
    if (view === "day3") setAnchor(ymd(addDays(anchorDate, dir * 3)));
    else if (view === "week") setAnchor(ymd(addDays(anchorDate, dir * 7)));
    else setAnchor(ymd(new Date(anchorDate.getFullYear(), anchorDate.getMonth() + dir, 1)));
  };

  const rangeLabel =
    view === "month"
      ? `${MONTHS[anchorDate.getMonth()]} ${anchorDate.getFullYear()}`
      : `${fmtShort(days[0]!)} – ${fmtShort(days[days.length - 1]!)}, ${anchorDate.getFullYear()}`;

  const cols = view === "day3" ? 3 : 7;
  const dayCell = (d: string) => {
    const items = byDay.get(d) ?? [];
    const feedItems = feedByDay.get(d) ?? [];
    const dd = new Date(`${d}T00:00`);
    return (
      <div key={d} className={`cal-cell${d === today ? " today" : ""}${d === anchor && view !== "month" ? " anchor" : ""}`}>
        <div className="cal-cell-head">
          {view === "month" ? (
            <span className="cal-daynum">{dd.getDate()}</span>
          ) : (
            <>
              <span className="cal-dow">{WEEKDAYS[dd.getDay()]}</span>
              <span className="cal-daynum">{dd.getDate()}</span>
            </>
          )}
        </div>
        <div className="cal-cell-body">
          {items.map((it) => (
            <Chip key={it.id} item={it} types={types} onStatus={onStatus} />
          ))}
          {feedItems.map((ev) => (
            <FeedChip key={`${ev.feedId}:${ev.uid}:${ev.start}`} event={ev} />
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="cal-wrap" onClick={selectCollection}>
      <div className="cal-toolbar">
        <span className="segmented">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              className={`seg${view === v.key ? " active" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                setViewMode(v.key);
              }}
            >
              {v.label}
            </button>
          ))}
        </span>
        <span className="cal-nav">
          <button className="icon-btn" title="Previous" onClick={(e) => { e.stopPropagation(); step(-1); }}>
            <ChevronLeft size={16} />
          </button>
          <button className="ghost cal-today-btn" onClick={(e) => { e.stopPropagation(); setAnchor(today); }}>
            Today
          </button>
          <button className="icon-btn" title="Next" onClick={(e) => { e.stopPropagation(); step(1); }}>
            <ChevronRight size={16} />
          </button>
        </span>
        <span className="cal-range">{rangeLabel}</span>
        {!isSmart && <span className="hint">Calendars are query-fed — give this collection a query.</span>}
      </div>

      {feeds.length > 0 && (
        <div className="cal-feed-toggles" onClick={(e) => e.stopPropagation()}>
          {feeds.map((f) => {
            const hidden = hiddenFeeds.has(f.id);
            return (
              <button
                key={f.id}
                className={`cal-feed-toggle${hidden ? " off" : ""}`}
                style={{ ["--feed-color" as string]: f.color }}
                title={hidden ? `Show ${f.name}` : `Hide ${f.name}`}
                onClick={() => toggleFeed(f.id)}
              >
                <span className="cal-feed-toggle-dot" style={{ background: f.color }} />
                {f.name}
              </button>
            );
          })}
        </div>
      )}

      {view === "month" ? (
        <>
          <div className="cal-dow-row" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
            {WEEKDAYS.map((w) => (
              <span key={w} className="cal-dow-cell">{w}</span>
            ))}
          </div>
          <div className="cal-grid cal-month" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
            {days.map(dayCell)}
          </div>
        </>
      ) : (
        <TimeGrid
          view={view}
          days={days}
          cols={cols}
          today={today}
          grid={timeGrid}
          types={types}
          onStatus={onStatus}
          scrollRef={scrollRef}
        />
      )}
    </div>
  );
}

/** Week / 3-day time-band view: an all-day band on top, then an hour grid where
 *  timed events fall in their correct band (overlaps split into lanes). */
function TimeGrid({
  view,
  days,
  cols,
  today,
  grid,
  types,
  onStatus,
  scrollRef,
}: {
  view: ViewMode;
  days: string[];
  cols: number;
  today: string;
  grid: Map<string, { allDay: GridRef[]; timed: TimedEntry[] }>;
  types: BlockType[];
  onStatus: (item: Item, field: FieldDef, next: string) => void;
  scrollRef: React.RefObject<HTMLDivElement>;
}) {
  const template = `52px repeat(${cols}, 1fr)`;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const todayVisible = days.includes(today);
  const renderRef = (ref: GridRef) =>
    ref.kind === "block" ? (
      <Chip item={ref.item} types={types} onStatus={onStatus} />
    ) : (
      <FeedChip event={ref.event} />
    );

  return (
    <div className={`cal-timegrid cal-${view}`}>
      <div className="cal-tg-head" style={{ gridTemplateColumns: template }}>
        <span className="cal-tg-corner" />
        {days.map((d) => {
          const dd = new Date(`${d}T00:00`);
          return (
            <span key={d} className={`cal-tg-dayhead${d === today ? " today" : ""}`}>
              <span className="cal-dow">{WEEKDAYS[dd.getDay()]}</span>
              <span className="cal-daynum">{dd.getDate()}</span>
            </span>
          );
        })}
      </div>

      <div className="cal-tg-allday" style={{ gridTemplateColumns: template }}>
        <span className="cal-tg-allday-label">all-day</span>
        {days.map((d) => (
          <div key={d} className={`cal-tg-allday-col${d === today ? " today" : ""}`}>
            {(grid.get(d)?.allDay ?? []).map((ref) => (
              <div key={ref.key} className="cal-tg-allday-item">{renderRef(ref)}</div>
            ))}
          </div>
        ))}
      </div>

      <div className="cal-tg-scroll" ref={scrollRef}>
        <div className="cal-tg-grid" style={{ gridTemplateColumns: template, height: 24 * HOUR_H }}>
          <div className="cal-tg-gutter">
            {Array.from({ length: 24 }, (_, h) => (
              <span key={h} className="cal-tg-hour" style={{ top: h * HOUR_H }}>
                {h > 0 ? fmtHour(h) : ""}
              </span>
            ))}
          </div>
          {days.map((d) => (
            <div key={d} className={`cal-tg-col${d === today ? " today" : ""}`}>
              {todayVisible && d === today && (
                <div className="cal-tg-now" style={{ top: (nowMin / 60) * HOUR_H }} />
              )}
              {(grid.get(d)?.timed ?? []).map((e) => {
                const width = 100 / e.lanes;
                return (
                  <div
                    key={e.ref.key}
                    className="cal-tg-event"
                    style={{
                      top: (e.startMin / 60) * HOUR_H,
                      height: Math.max(((e.endMin - e.startMin) / 60) * HOUR_H, 18),
                      left: `${e.lane * width}%`,
                      width: `calc(${width}% - 3px)`,
                    }}
                  >
                    {renderRef(e.ref)}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
