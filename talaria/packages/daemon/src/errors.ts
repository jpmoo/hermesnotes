/**
 * The errors both clients raise, in one place.
 *
 * There were two `OfflineError` classes — one in `hermes.ts`, one in
 * `interchange.ts` — and nothing said so. `server.ts` imported the first and
 * caught it around a write that goes through the *second*, so `instanceof` was
 * false and an offline write fell past the queue into a 500. The message was
 * identical either way ("fetch failed"), which is why it read as a network
 * error rather than as a bug: the daemon's whole offline story — writes queue
 * and go out on reconnect — was broken for creates, and had been since the
 * write path moved onto the binding.
 *
 * One class, imported by both. An error used to decide control flow across
 * modules cannot be a per-module definition; that is what makes this a module
 * rather than two lines.
 */

/** The far end could not be reached at all. Not an answer, and not a refusal. */
export class OfflineError extends Error {}

/** The producer says that object is gone. */
export class GoneError extends Error {}
