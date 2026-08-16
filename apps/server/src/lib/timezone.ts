import { isValidTimeZone } from "@hermes/shared";
import { env } from "../env.js";

/**
 * The zone to reckon this user's days in: their own, else the one the instance
 * was configured with, else nothing.
 *
 * "Nothing" leaves the caller on this process's clock, which is a fact about
 * where the box is hosted rather than about the reader — a server running UTC
 * is already on tomorrow's date from early evening in the Americas, which is
 * enough to file a note under the wrong day. Every path that decides what day
 * it is goes through here, so there's one answer to change and one place to
 * look when the answer is wrong.
 */
export function effectiveTimeZone(userTz: string | null | undefined): string | null {
  if (isValidTimeZone(userTz)) return userTz;
  if (isValidTimeZone(env.DEFAULT_TIMEZONE)) return env.DEFAULT_TIMEZONE;
  return null;
}

/** Minutes that `tz` is ahead of UTC at the given instant. */
function tzOffsetMinutes(utcMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  const hour = Number(p.hour) === 24 ? 0 : Number(p.hour);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second));
  return (asUtc - utcMs) / 60000;
}

/**
 * The UTC half-open range [start, end) covering a calendar date in `tz`. A null
 * or invalid tz falls back to the server's local day.
 */
export function zonedDayRange(date: string, tz: string | null): { start: Date; end: Date } {
  const [y, m, d] = date.split("-").map(Number);
  const local = () => {
    const start = new Date(y!, m! - 1, d!, 0, 0, 0);
    return { start, end: new Date(start.getTime() + 86_400_000) };
  };
  if (!tz) return local();
  try {
    const guess = Date.UTC(y!, m! - 1, d!, 0, 0, 0);
    const off = tzOffsetMinutes(guess, tz);
    const start = new Date(guess - off * 60_000);
    return { start, end: new Date(start.getTime() + 86_400_000) };
  } catch {
    return local();
  }
}
