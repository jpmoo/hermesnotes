import {
  completable as completableType,
  fieldFor,
  isComplete,
  optionLabel,
  read,
  type InterchangeObject,
  type InterchangeType,
} from "./interchange.js";
import { kindOf } from "./kind.js";
import { toCanonicalRecurrence, type Series } from "./recurrence.js";
import type { CanonicalBlock, CanonicalLink, CanonicalSpan, CanonicalWhen } from "./types.js";

/**
 * The seam now takes `pkm-interchange/0` and nothing else.
 *
 * It used to take a Hermes block and a Hermes type, and read meaning out of
 * `status_field`, `bodyFieldKey` and a field whose `type` was `"recurrence"` —
 * all of them Hermes' private words for things. Everything downstream already
 * spoke the canonical shape, so this was the only place that had to change for
 * Talaria to stop being a Hermes satellite.
 */

/**
 * The scheme the app bundle claims. Not `hermes`: that is another tool on this
 * machine, and the CLI is `talaria` for the same reason.
 */
export const URL_SCHEME = "talaria";

const UUID = "[0-9a-fA-F-]{36}";
const LINK_RE = new RegExp(`\\[([^\\]]*)\\]\\(block:(${UUID})\\)`, "g");
const BARE_RE = new RegExp(`\\|(${UUID})`, "g");
const SCHEME_RE = /\[([^\]]*)\]\((?:person|tag):([^)]*)\)/g;

/**
 * Mention syntax as a reader sees it: link and person labels kept, tags and bare
 * ids dropped. A title that says `Write up |048dd1db-…` should read "Write up",
 * not recite a uuid at somebody.
 */
function readable(raw: string): string {
  return String(raw ?? "")
    .replace(LINK_RE, (_m, label: string) => label)
    .replace(SCHEME_RE, (_m, label: string, arg: string) =>
      label || String(arg).replace(/_/g, " "),
    )
    .replace(BARE_RE, "")
    .replace(/(^|\s)#[A-Za-z0-9][\w-]*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every block this one points at, by whatever route. */
function linksOf(
  type: InterchangeType | undefined,
  props: Record<string, unknown>,
  text: string,
): CanonicalLink[] {
  const seen = new Map<string, CanonicalLink>();
  for (const f of type?.fields ?? []) {
    if (f.kind !== "reference") continue;
    const v = props[f.key];
    for (const id of Array.isArray(v) ? v : [v]) {
      if (typeof id === "string" && id) seen.set(id, { id, role: f.key });
    }
  }
  for (const re of [LINK_RE, BARE_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const id = m[2] ?? m[1];
      // A reference field is a stronger statement than a mention in prose, so
      // it keeps its role when a block is named both ways.
      if (id && !seen.has(id)) seen.set(id, { id, role: "mention" });
    }
  }
  return [...seen.values()];
}

/** `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm`, per the format. Anything else is not a date. */
function whenOf(v: unknown): CanonicalWhen | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  return { value: v, allDay: !v.includes("T") };
}

/**
 * When this thing happens.
 *
 * Declared first: `start` and `due` on the task profile, `start`/`end` on the
 * event profile. The producer has already said which of its fields those are,
 * and one producer's single datespan is both halves — so the mapping is asked
 * rather than the field list guessed at.
 *
 * The guess below it is for types that declared nothing, which is most of a real
 * library. It is a consumer's own heuristic over what it was given, and being
 * wrong about it costs a date on a card rather than anything structural.
 */
function scheduleOf(type: InterchangeType | undefined, object: InterchangeObject): CanonicalSpan | null {
  for (const profile of ["task", "event"] as const) {
    const startKey = profile === "task" ? "start" : "start";
    const endKey = profile === "task" ? "due" : "end";
    const start = whenOf(read(type, object, startKey, profile));
    const end = whenOf(read(type, object, endKey, profile));
    if (!start && !end) continue;
    const sf = fieldFor(type, startKey, profile);
    const ef = fieldFor(type, endKey, profile);
    // One compound field mapped twice: its own two labels are the right words.
    const compound = sf && ef && sf.key === ef.key ? sf : null;
    return {
      start,
      end,
      startLabel: compound?.startLabel ?? sf?.label ?? null,
      endLabel: compound?.endLabel ?? ef?.label ?? null,
    };
  }

  const props = object.properties ?? {};
  const fields = type?.fields ?? [];
  const span = fields.find((f) => f.kind === "datespan");
  if (span) {
    const v = (props[span.key] ?? {}) as { start?: unknown; end?: unknown };
    const start = whenOf(v.start);
    const end = whenOf(v.end);
    if (!start && !end) return null;
    return { start, end, startLabel: span.startLabel ?? null, endLabel: span.endLabel ?? null };
  }
  const point = fields.find((f) => f.kind === "datetime" || f.kind === "date");
  if (!point) return null;
  const at = whenOf(props[point.key]);
  return at ? { start: at, end: null, startLabel: point.label ?? null, endLabel: null } : null;
}

/**
 * An interchange object as the canonical object. The one translation in the
 * system: nothing downstream of this function should ever hold a payload.
 */
export function toCanonical(
  object: InterchangeObject,
  type: InterchangeType | undefined,
  opts: { appOrigin: string; collectionKind?: string | null; series?: Series | null },
): CanonicalBlock {
  const props = object.properties ?? {};
  const collectionKind = opts.collectionKind ?? null;

  // Hermes' word for "this note is the daily note for that day". Not a format
  // concept, so it reads as an unrecognised property — which is exactly what the
  // round-trip rule protects, and it is legible enough to use.
  const noteDate = typeof props.today_note === "string" ? props.today_note : null;

  const rawTitle = String(read(type, object, "title", "note") ?? read(type, object, "title", "task") ?? props.title ?? "");
  const rawBody = String(read(type, object, "body", "note") ?? object.content ?? "");

  // A note usually carries no title of its own, so its first non-empty line
  // stands in — the same thing a reader does when glancing at it.
  const firstLine = (rawBody.split("\n").find((l) => l.trim()) ?? "").replace(/^#+\s*/, "");
  const title =
    readable(rawTitle) ||
    (noteDate ? `Daily note — ${noteDate}` : "") ||
    readable(firstLine) ||
    "Untitled";

  const statusValue = read(type, object, "status", "task");
  const completion =
    typeof statusValue === "string"
      ? {
          status: statusValue,
          label: optionLabel(fieldFor(type, "status", "task"), statusValue),
          done: isComplete(type, object),
          // Not a format concept either. Producers that stamp one are common and
          // it is only ever displayed, so an absent one costs a line of detail.
          doneAt: typeof props.done_at === "string" ? props.done_at : null,
        }
      : null;

  return {
    id: object.id,
    kind: kindOf(type, { collectionKind }),
    typeId: object.type ?? null,
    typeName: collectionKind ?? type?.name ?? "unknown",
    title,
    body: rawBody ? rawBody : null,
    completion,
    completable: completableType(type),
    schedule: scheduleOf(type, object),
    // The format holds recurrence as a series the object points at, so there is
    // nothing to synthesize any more: the producer already said which occurrences
    // belong together, which is the thing Hermes could not say and this seam
    // used to invent.
    recurrence: toCanonicalRecurrence(opts.series ?? null),
    tags: object.tags ?? [],
    links: linksOf(type, props, `${rawTitle}\n${rawBody}`),
    isDailyNote: noteDate !== null,
    noteDate,
    collectionKind,
    archivedAt: object.archived ? (object.updated ?? null) : null,
    createdAt: String(object.created ?? ""),
    updatedAt: String(object.updated ?? ""),
    version: object.version ?? 0,
    url: `${opts.appOrigin.replace(/\/$/, "")}/${collectionKind ? "collections" : "block"}/${object.id}`,
    appUrl: `${URL_SCHEME}://${collectionKind ? "collection" : "block"}/${object.id}`,
  };
}
