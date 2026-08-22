import { bodyFieldKey, dayOf, isComplete, optionLabel, type PropertySchema } from "@hermes/shared";
import { kindOf } from "./kind.js";
import { toCanonicalRecurrence } from "./recurrence.js";
import type { CanonicalBlock, CanonicalLink, CanonicalSpan, CanonicalWhen } from "./types.js";

/** A block as `/sync/blocks` hands it over. The only Hermes shape in this package. */
export interface HermesBlockRow {
  id: string;
  blockTypeId: string | null;
  collectionKind: string | null;
  content: string | null;
  properties: Record<string, unknown>;
  version: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  tags: string[];
}

/** A block type as `/block-types` hands it over. */
export interface HermesTypeRow {
  id: string;
  name: string;
  propertySchema: PropertySchema | null;
  isText: boolean;
  builtin: boolean;
}

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
  schema: PropertySchema | null | undefined,
  props: Record<string, unknown>,
  text: string,
): CanonicalLink[] {
  const seen = new Map<string, CanonicalLink>();
  for (const f of schema?.fields ?? []) {
    if (f.type !== "reference") continue;
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

function whenOf(v: unknown): CanonicalWhen | null {
  if (typeof v !== "string" || !v) return null;
  const day = dayOf(v);
  if (!day) return null;
  return { value: v, allDay: !v.includes("T") };
}

/** The type's dated field, preferring a span over a single point. */
function scheduleOf(
  schema: PropertySchema | null | undefined,
  props: Record<string, unknown>,
): CanonicalSpan | null {
  const fields = schema?.fields ?? [];
  const span = fields.find((f) => f.type === "datespan");
  if (span) {
    const v = (props[span.key] ?? {}) as { start?: unknown; end?: unknown };
    const start = whenOf(v.start);
    const end = whenOf(v.end);
    if (!start && !end) return null;
    return {
      start,
      end,
      startLabel: span.startLabel ?? null,
      endLabel: span.endLabel ?? null,
    };
  }
  const point = fields.find((f) => f.type === "datetime" || f.type === "date");
  if (!point) return null;
  const at = whenOf(props[point.key]);
  return at ? { start: at, end: null, startLabel: point.label ?? null, endLabel: null } : null;
}

/**
 * A Hermes block as the canonical object. The one translation in the system:
 * nothing downstream of this function should ever hold a raw payload.
 */
export function toCanonical(
  row: HermesBlockRow,
  type: HermesTypeRow | undefined,
  opts: { appOrigin: string },
): CanonicalBlock {
  const props = row.properties ?? {};
  const schema = type?.propertySchema ?? null;
  const isText = type?.isText ?? false;

  const noteDate = typeof props.today_note === "string" ? props.today_note : null;

  const rawTitle = typeof props.title === "string" ? props.title : "";
  const bodyKey = bodyFieldKey(schema);
  const rawBody = isText
    ? (row.content ?? "")
    : bodyKey && typeof props[bodyKey] === "string"
      ? (props[bodyKey] as string)
      : "";

  // A text block usually carries no title, so its first non-empty line stands in
  // — the same thing a reader does when glancing at it.
  const firstLine = (rawBody.split("\n").find((l) => l.trim()) ?? "").replace(/^#+\s*/, "");
  const title =
    readable(rawTitle) ||
    (noteDate ? `Daily note — ${noteDate}` : "") ||
    readable(firstLine) ||
    "Untitled";

  const statusKey = schema?.status_field ?? null;
  const statusField = statusKey ? (schema?.fields ?? []).find((f) => f.key === statusKey) : null;
  const statusValue = statusKey ? props[statusKey] : null;
  const completion =
    schema && statusField && typeof statusValue === "string"
      ? {
          status: statusValue,
          label: optionLabel(statusField, statusValue),
          done: isComplete(schema, props),
          doneAt: typeof props.done_at === "string" ? props.done_at : null,
        }
      : null;

  const recField = (schema?.fields ?? []).find((f) => f.type === "recurrence");
  const completable = Boolean(schema?.status_field && schema.complete_values?.length);

  return {
    id: row.id,
    kind: kindOf(type?.name ?? null, schema, {
      builtin: type?.builtin,
      isText,
      collectionKind: row.collectionKind,
    }),
    typeId: row.blockTypeId,
    typeName: row.collectionKind ?? type?.name ?? "unknown",
    title,
    body: rawBody ? rawBody : null,
    completion,
    completable,
    schedule: scheduleOf(schema, props),
    recurrence: recField
      ? toCanonicalRecurrence(props[recField.key], { typeId: row.blockTypeId, title })
      : null,
    tags: row.tags ?? [],
    links: linksOf(schema, props, `${rawTitle}\n${rawBody}`),
    isDailyNote: noteDate !== null,
    noteDate,
    collectionKind: row.collectionKind,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
    // A collection is a block, but the web app routes to it differently, and a
    // Spotlight hit that opens an error page is worse than no hit at all.
    url: `${opts.appOrigin.replace(/\/$/, "")}/${row.collectionKind ? "collections" : "block"}/${row.id}`,
    appUrl: `${URL_SCHEME}://${row.collectionKind ? "collection" : "block"}/${row.id}`,
  };
}
