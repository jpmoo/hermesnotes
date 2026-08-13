/**
 * A stored date or datetime field value, read back the way it was written.
 *
 * Two things the generic timestamp formatter gets wrong here. A date with no
 * time is "2026-08-15", which the Date constructor reads as midnight UTC and
 * then prints in the reader's zone — west of Greenwich that's the evening
 * before. And it always prints a time, so a day with no time on it acquired a
 * 12:00 AM that nobody chose. Appending T00:00 makes it local, and the time is
 * shown only when there is one.
 */
export function fmtWhen(v: string | null | undefined): string {
  if (!v) return "";
  const hasTime = v.includes("T");
  const d = new Date(hasTime ? v : `${v}T00:00`);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString(
    undefined,
    hasTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" },
  );
}

/** Human date + time, e.g. "Aug 15, 2026, 3:42 PM". For real timestamps
 *  (created/edited), which carry a zone of their own. */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return "";
  }
}
