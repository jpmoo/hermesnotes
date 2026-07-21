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
