import { api } from "../api.ts";

/**
 * Where this browser thinks it is, as an IANA name ("America/New_York").
 * Empty if the runtime won't say, which no browser we support does.
 */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

/**
 * Fill in a timezone for an account that has never had one.
 *
 * Day boundaries are worked out server-side, and with nothing set the server
 * used its own clock — which on a box running UTC is already tomorrow from the
 * evening onwards. That put an agent's "today's daily note" on the wrong day,
 * shifted the Today sheet's activity window, and moved what `today` meant in a
 * smart collection, all without anything looking wrong on screen.
 *
 * Accounts made before sign-up asked for it have no way to know any of that, so
 * the first page load fills it in from the browser: the best guess available,
 * strictly better than the server's clock, and changeable in Settings. Once
 * only — a value already set is the reader's, including one they chose while
 * somewhere else.
 */
export async function ensureTimeZone(): Promise<void> {
  const tz = browserTimeZone();
  if (!tz) return;
  try {
    const s = await api.get<{ timezone: string | null }>("/settings");
    if (s.timezone) return;
    await api.patch("/settings", { timezone: tz });
  } catch {
    /* offline, or not signed in yet: it'll be tried again next load */
  }
}
