/**
 * The canonical object — the only shape anything downstream of here is allowed
 * to see.
 *
 * The seam exists so that adopting some external schema later is a change to one
 * module rather than to every surface (brief §6). Version 0 is close to a
 * rename, and that's fine; what matters is that the CLI, the Spotlight indexer
 * and the App Intents entities consume *this* and never a Hermes payload.
 */

/**
 * What a block *is*, as distinct from what its type is called.
 *
 * Hermes block types are rows the user owns, not code: they can be renamed,
 * given fields, deleted. So `kind` is derived from a type's shape rather than
 * read off its name — see `kind.ts` — and a renamed Task keeps working.
 */
export type CanonicalKind =
  | "task"
  | "event"
  | "note"
  | "person"
  | "project"
  | "organization"
  | "other";

/** A point in time, or a day when no time was given. */
export interface CanonicalWhen {
  /** "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" as stored. */
  value: string;
  /** True when the stored value carries no time, so this is a whole day. */
  allDay: boolean;
}

/** A span with either end optional — an available/due pair, or an event's run. */
export interface CanonicalSpan {
  start: CanonicalWhen | null;
  end: CanonicalWhen | null;
  /** What the two ends are called on this type ("Available"/"Due"). */
  startLabel: string | null;
  endLabel: string | null;
}

export interface CanonicalCompletion {
  /** The raw stored status value. */
  status: string;
  /** How it should read — the type's own label for that value. */
  label: string;
  done: boolean;
  /** When it entered a complete value, if it has. */
  doneAt: string | null;
}

export interface CanonicalRecurrence {
  /**
   * Synthesized here, because Hermes has none: occurrences are separate blocks
   * linked by nothing. EventKit models recurrence as a master with occurrences
   * beneath it, so a bridge must have one — and inventing it once at the seam
   * beats inventing it separately in every bridge that needs it (DESIGN §3.2).
   */
  seriesId: string;
  anchor: "schedule" | "completion";
  frequency: "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
  /** 0 = Sunday. Empty when the rule doesn't name days. */
  weekdays: number[];
  end:
    | { kind: "never" }
    | { kind: "after"; count: number }
    | { kind: "on"; date: string };
  /** Which occurrence this block is, 1-based. Hermes' `n`, named for what it is. */
  occurrence: number | null;
  /**
   * False when `anchor` is "completion": RFC 5545 has no way to say "three days
   * after I actually finish it", so a bridge must materialize instances rather
   * than hand the rule over (DESIGN §3.3).
   */
  expressibleAsRRULE: boolean;
}

/** A pointer from this block to another. */
export interface CanonicalLink {
  id: string;
  /** The field it came through, or "mention" for one found in prose. */
  role: string;
}

export interface CanonicalBlock {
  id: string;
  kind: CanonicalKind;
  /** The Hermes type this came from, and what the user calls it. */
  typeId: string | null;
  typeName: string;
  title: string;
  /** The type's prose field, or a text block's own content. */
  body: string | null;
  completion: CanonicalCompletion | null;
  schedule: CanonicalSpan | null;
  recurrence: CanonicalRecurrence | null;
  tags: string[];
  links: CanonicalLink[];
  /** A daily note: held out of ordinary listings, but not second-class. */
  isDailyNote: boolean;
  /** The day a daily note belongs to. */
  noteDate: string | null;
  /** A collection (list, canvas, calendar…) rather than a block of a type. */
  collectionKind: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Carried so a queued write can tell whether the block moved underneath it. */
  version: number;
  /** Deep link into the web app. */
  url: string;
}
