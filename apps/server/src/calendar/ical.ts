/**
 * Minimal iCalendar (RFC 5545) parser + recurrence expansion. Deliberately
 * self-contained (no dependency) and scoped to what the calendar feature needs:
 * VEVENT summary/description/location, DTSTART/DTEND (date & date-time), UID,
 * and a common subset of RRULE (FREQ + INTERVAL/COUNT/UNTIL/BYDAY). Recurrences
 * are expanded only within a requested window, with a hard cap, so a runaway or
 * infinite rule can't blow up memory.
 */

export interface ParsedEvent {
  uid: string;
  summary: string;
  description: string;
  location: string;
  /** YYYY-MM-DD (all-day) or full ISO string (timed). */
  start: string;
  end: string | null;
  allDay: boolean;
}

interface RawEvent extends ParsedEvent {
  rrule: string | null;
  /** ms epoch of DTSTART, for recurrence math. */
  startMs: number;
  /** ms duration (end - start), preserved across recurrence instances. */
  durationMs: number;
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** Unfold folded lines (a leading space/tab continues the previous line). */
function unfold(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** Split "NAME;PARAM=x:VALUE" into { name, params, value }. */
function parseLine(line: string): { name: string; params: Record<string, string>; value: string } {
  const colon = line.indexOf(":");
  if (colon < 0) return { name: line.toUpperCase(), params: {}, value: "" };
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = head.split(";");
  const name = (parts.shift() ?? "").toUpperCase();
  const params: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }
  return { name, params, value };
}

function unescapeText(v: string): string {
  return v
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

/** Common Windows/Outlook TZID names → IANA. Microsoft (Office 365, Exchange)
 * feeds label DTSTART with these instead of IANA zones. */
const WINDOWS_TZ: Record<string, string> = {
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "US Mountain Standard Time": "America/Phoenix",
  "Pacific Standard Time": "America/Los_Angeles",
  "Atlantic Standard Time": "America/Halifax",
  "Alaskan Standard Time": "America/Anchorage",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "UTC": "UTC",
  "GMT Standard Time": "Europe/London",
  "W. Europe Standard Time": "Europe/Berlin",
  "Central Europe Standard Time": "Europe/Budapest",
  "Romance Standard Time": "Europe/Paris",
};

/**
 * Cached zone formatters. Constructing an Intl.DateTimeFormat is expensive and
 * a feed can carry tens of thousands of events, all naming the same handful of
 * zones — building one per event made parsing a large feed block the event loop
 * for seconds. Keyed by zone; a feed can only ever add as many entries as there
 * are distinct TZIDs it names, and an invalid zone throws before being cached.
 */
const ZONE_FMT = new Map<string, Intl.DateTimeFormat>();
function zoneFormatter(tz: string): Intl.DateTimeFormat {
  const hit = ZONE_FMT.get(tz);
  if (hit) return hit;
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  // Bound the cache: a hostile feed could otherwise name unlimited valid zones.
  if (ZONE_FMT.size < 500) ZONE_FMT.set(tz, dtf);
  return dtf;
}

/** ms by which `tz`'s wall clock leads UTC at the given instant. */
function tzOffsetMs(instant: number, tz: string): number {
  const dtf = zoneFormatter(tz);
  const p: Record<string, number> = {};
  for (const part of dtf.formatToParts(new Date(instant)))
    if (part.type !== "literal") p[part.type] = Number(part.value);
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!, p.second!) - instant;
}

/** Convert a wall-clock time expressed in `tz` to a UTC epoch (ms). Two passes
 * so instants near a DST transition still resolve. Null if `tz` is unknown. */
function zonedWallToMs(y: number, mo: number, d: number, hh: number, mm: number, ss: number, tz: string): number | null {
  try {
    const naive = Date.UTC(y, mo - 1, d, hh, mm, ss);
    const utc1 = naive - tzOffsetMs(naive, tz);
    return naive - tzOffsetMs(utc1, tz);
  } catch {
    return null; // Intl throws RangeError on an unrecognized zone
  }
}

/**
 * Parse a DTSTART/DTEND value into { ms, allDay }. Handles:
 *   20260125                              (DATE, all-day)
 *   20260125T133000Z                      (UTC)
 *   20260125T133000 + TZID=America/...    (wall time in a named zone)
 *   20260125T133000                       (floating — treated as UTC to stay stable)
 * TZID (IANA or Windows name) is resolved to its zone so timed events land at
 * the right instant; unknown zones and floating times fall back to UTC.
 */
function parseDateValue(value: string, params: Record<string, string>): { ms: number; allDay: boolean } | null {
  const isDate = params.VALUE === "DATE" || /^\d{8}$/.test(value);
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, z] = m;
  const nums = [Number(y), Number(mo), Number(d), Number(hh ?? 0), Number(mm ?? 0), Number(ss ?? 0)] as const;

  // A zone-qualified wall time (not UTC-marked, not all-day): resolve the zone.
  if (!isDate && !z && params.TZID) {
    const raw = params.TZID.replace(/^"|"$/g, ""); // strip DQUOTEs if present
    // Own-property lookup only: a TZID of `constructor`/`toString`/`__proto__`
    // would otherwise resolve up the prototype chain to a function.
    const mapped = Object.prototype.hasOwnProperty.call(WINDOWS_TZ, raw) ? WINDOWS_TZ[raw] : undefined;
    const tz = mapped ?? raw;
    const ms = zonedWallToMs(nums[0], nums[1], nums[2], nums[3], nums[4], nums[5], tz);
    if (ms != null) return { ms, allDay: false };
  }

  const ms = Date.UTC(nums[0], nums[1] - 1, nums[2], nums[3], nums[4], nums[5]);
  return { ms, allDay: isDate };
}

/** Format an instance for output, given its start ms + all-day flag. */
function formatInstance(ev: RawEvent, startMs: number): ParsedEvent {
  const endMs = startMs + ev.durationMs;
  if (ev.allDay) {
    // All-day DTEND in iCal is exclusive; step back a day for an inclusive end.
    const inclusiveEnd = ev.durationMs > 0 ? endMs - 86400000 : startMs;
    return {
      ...ev,
      start: ymd(new Date(startMs)),
      end: ev.durationMs > 86400000 ? ymd(new Date(inclusiveEnd)) : null,
      allDay: true,
    };
  }
  return {
    ...ev,
    start: new Date(startMs).toISOString(),
    end: ev.durationMs > 0 ? new Date(endMs).toISOString() : null,
    allDay: false,
  };
}

const DAY_MS = 86400000;
const RRULE_CAP = 500; // max instances expanded per rule

const WEEKDAY_INDEX: Record<string, number> = {
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
};

/** Expand one event's occurrences that intersect [windowStart, windowEnd] (ms). */
function expand(ev: RawEvent, windowStart: number, windowEnd: number): number[] {
  if (!ev.rrule) {
    // Single occurrence: include if it overlaps the window at all.
    const end = ev.startMs + ev.durationMs;
    return end >= windowStart && ev.startMs <= windowEnd ? [ev.startMs] : [];
  }

  const parts: Record<string, string> = {};
  for (const p of ev.rrule.split(";")) {
    const eq = p.indexOf("=");
    if (eq > 0) parts[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).toUpperCase();
  }
  const freq = parts.FREQ;
  if (!freq) return [ev.startMs];
  const interval = Math.max(1, Number(parts.INTERVAL) || 1);
  const count = parts.COUNT ? Number(parts.COUNT) : Infinity;
  let until = Infinity;
  if (parts.UNTIL) {
    const u = parseDateValue(parts.UNTIL, {});
    if (u) until = u.ms;
  }
  const byDays = parts.BYDAY
    ? parts.BYDAY.split(",")
        .map((d) => WEEKDAY_INDEX[d.replace(/^[+-]?\d+/, "")])
        .filter((n): n is number => n != null)
    : null;

  const out: number[] = [];
  const start = new Date(ev.startMs);
  let emitted = 0;
  let iterations = 0;
  const cap = Math.min(count, RRULE_CAP);

  // Walk period-by-period from DTSTART; within a period, emit BYDAY days for
  // weekly rules (or just the base day otherwise).
  const cursor = new Date(ev.startMs);
  while (emitted < cap && iterations < 5000) {
    iterations++;
    const periodDays: number[] = [];
    if (freq === "WEEKLY" && byDays) {
      const weekStart = new Date(cursor);
      weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
      for (const wd of byDays) {
        const d = new Date(weekStart);
        d.setUTCDate(d.getUTCDate() + wd);
        d.setUTCHours(start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(), 0);
        if (d.getTime() >= ev.startMs) periodDays.push(d.getTime());
      }
    } else {
      periodDays.push(cursor.getTime());
    }

    for (const ms of periodDays.sort((a, b) => a - b)) {
      if (ms > until || emitted >= cap) break;
      emitted++;
      const end = ms + ev.durationMs;
      if (end >= windowStart && ms <= windowEnd) out.push(ms);
      if (ms > windowEnd) return out; // past the window — later instances only get further away
    }

    // Advance the cursor by one interval period.
    if (freq === "DAILY") cursor.setUTCDate(cursor.getUTCDate() + interval);
    else if (freq === "WEEKLY") cursor.setUTCDate(cursor.getUTCDate() + 7 * interval);
    else if (freq === "MONTHLY") cursor.setUTCMonth(cursor.getUTCMonth() + interval);
    else if (freq === "YEARLY") cursor.setUTCFullYear(cursor.getUTCFullYear() + interval);
    else break;

    if (cursor.getTime() > windowEnd && emitted > 0) break;
    if (cursor.getTime() - ev.startMs > 366 * 20 * DAY_MS) break; // 20-year safety
  }
  return out;
}

/**
 * Render an instant as a floating wall-clock string ("YYYY-MM-DDTHH:mm:ss") in
 * the given IANA timezone. Feed events are real instants (UTC); the app shows
 * everything in the user's configured zone, and the front-end treats these
 * offsetless strings as face-value wall-clock.
 */
export function toZonedFloating(iso: string, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(d);
  } catch {
    return iso; // unknown tz — leave as-is
  }
  const g = (t: string) => parts.find((x) => x.type === t)?.value ?? "00";
  const hour = g("hour") === "24" ? "00" : g("hour");
  return `${g("year")}-${g("month")}-${g("day")}T${hour}:${g("minute")}:${g("second")}`;
}

/** Convert a timed event's start/end into the given timezone; all-day untouched. */
export function zoneEvent(ev: ParsedEvent, tz: string): ParsedEvent {
  if (ev.allDay) return ev;
  return {
    ...ev,
    start: toZonedFloating(ev.start, tz),
    end: ev.end ? toZonedFloating(ev.end, tz) : null,
  };
}

/** Parse an ICS document into raw events (recurrence rules preserved). */
export function parseIcs(text: string): RawEvent[] {
  const lines = unfold(text);
  const events: RawEvent[] = [];
  let cur: Partial<RawEvent> & { _startMs?: number; _endMs?: number; _allDay?: boolean } | null = null;

  for (const line of lines) {
    const { name, params, value } = parseLine(line);
    if (name === "BEGIN" && value === "VEVENT") {
      cur = { summary: "", description: "", location: "", uid: "", rrule: null };
      continue;
    }
    if (name === "END" && value === "VEVENT") {
      if (cur && cur._startMs != null) {
        const startMs = cur._startMs;
        const endMs = cur._endMs ?? (cur._allDay ? startMs + DAY_MS : startMs);
        events.push({
          uid: cur.uid || `${startMs}`,
          summary: cur.summary || "(untitled)",
          description: cur.description || "",
          location: cur.location || "",
          allDay: cur._allDay ?? false,
          rrule: cur.rrule ?? null,
          startMs,
          durationMs: Math.max(0, endMs - startMs),
          start: "",
          end: null,
        });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    switch (name) {
      case "UID":
        cur.uid = value;
        break;
      case "SUMMARY":
        cur.summary = unescapeText(value);
        break;
      case "DESCRIPTION":
        cur.description = unescapeText(value);
        break;
      case "LOCATION":
        cur.location = unescapeText(value);
        break;
      case "DTSTART": {
        const d = parseDateValue(value, params);
        if (d) {
          cur._startMs = d.ms;
          cur._allDay = d.allDay;
        }
        break;
      }
      case "DTEND": {
        const d = parseDateValue(value, params);
        if (d) cur._endMs = d.ms;
        break;
      }
      case "RRULE":
        cur.rrule = value;
        break;
      default:
        break;
    }
  }
  return events;
}

/**
 * Parse + expand an ICS document into concrete event instances overlapping
 * [startISO, endISO] (YYYY-MM-DD, inclusive). Deduped by (uid, start).
 */
export function eventsInRange(icsText: string, startISO: string, endISO: string): ParsedEvent[] {
  const [sy, sm, sd] = startISO.split("-").map(Number) as [number, number, number];
  const windowStart = Date.UTC(sy, sm - 1, sd);
  const [ey, em, ed] = endISO.split("-").map(Number) as [number, number, number];
  const windowEnd = Date.UTC(ey, em - 1, ed) + DAY_MS - 1; // last ms of the last day
  const raw = parseIcs(icsText);
  const out: ParsedEvent[] = [];
  const seen = new Set<string>();
  for (const ev of raw) {
    for (const startMs of expand(ev, windowStart, windowEnd)) {
      const inst = formatInstance(ev, startMs);
      const key = `${ev.uid}|${inst.start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(inst);
    }
  }
  return out;
}
