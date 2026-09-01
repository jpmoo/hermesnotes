import { completable, declares, type InterchangeType } from "./interchange.js";
import type { CanonicalKind } from "./types.js";

/**
 * What a block type *is*, worked out from its shape.
 *
 * Hermes' own rule is that nothing outside a type's property schema may
 * special-case a type — "if you find yourself writing `if (blockType.name ===
 * 'task')`, the answer belongs here instead". That rule exists because types are
 * user data: renameable, extensible, deletable. Talaria has to honour it for a
 * harder reason than tidiness — App Intents entities are fixed at compile time,
 * so the mapping from a user's types onto a fixed set of kinds is the only place
 * that can absorb the mismatch.
 *
 * A type that *declares* what it is settles the question outright — that is what
 * profiles are for, and reading a declaration is not guessing. Everything below
 * that is a fallback for types nobody has declared yet: structure first, then
 * the seeded names, then `other`. Those answers are marked `derived` so a caller
 * can tell an answer that was given from one that was worked out, and so this
 * whole tail can be deleted once declaring is the norm rather than the exception.
 *
 * Anything that matches nothing is `other`: indexed, searchable, openable, but
 * without bespoke Siri grammar — which fails gracefully rather than invisibly.
 */
/**
 * Which canonical kind each profile name settles the question as, most specific
 * first.
 *
 * A type may declare several — a Meeting is an event to a calendar and a note to
 * a notebook — and this list is the tie-break rather than whichever key happened
 * to be written first. Talaria wants the most actionable reading, because that
 * is the one with a grammar behind it: "when is my meeting" beats "read me my
 * meeting".
 *
 * `project` and `organization` are not in the v0 vocabulary. They are here for
 * the same reason the format keeps unknown profile names: a name earns its place
 * by being declared and used.
 */
const BY_PROFILE: [name: string, kind: CanonicalKind][] = [
  ["task", "task"],
  ["event", "event"],
  ["project", "project"],
  ["organization", "organization"],
  ["contact", "person"],
  ["note", "note"],
];

/**
 * The kind, and whether anybody actually said so.
 *
 * `derived` is the honest half. An answer worked out from a type's shape is
 * usually right and is never authoritative, and a caller that cannot tell the
 * difference will keep a wrong guess forever.
 */
export function resolveKind(
  type: InterchangeType | undefined,
  opts: { collectionKind?: string | null } = {},
): { kind: CanonicalKind; derived: boolean } {
  if (opts.collectionKind) return { kind: "other", derived: false };

  // Declared beats everything, including the shape. A type that says it is a
  // task is a task even if its status field was removed this morning.
  for (const [name, kind] of BY_PROFILE) {
    if (declares(type, name as "task" | "event" | "contact" | "note")) return { kind, derived: false };
  }

  return { kind: derive(type), derived: true };
}

export function kindOf(
  type: InterchangeType | undefined,
  opts: { collectionKind?: string | null } = {},
): CanonicalKind {
  return resolveKind(type, opts).kind;
}

/**
 * Everything below here is the guess.
 *
 * `project`, `person` and `organization` are not v0 profiles, so nothing can
 * declare them and this is the only way to have them at all. It is a consumer's
 * private heuristic over what it was given, which is allowed — what is not
 * allowed is presenting it as something the producer said, hence `derived`.
 */
function derive(type: InterchangeType | undefined): CanonicalKind {
  const fields = type?.fields ?? [];
  const has = (k: string) => fields.some((f) => f.kind === k);

  // Strongest signal first, and it doesn't care what the type is called: a thing
  // that can be finished is a task. This is what keeps a renamed Task working.
  if (completable(type)) return "task";

  // Then the name. The producer's own vocabulary is the best evidence available
  // when the shape says nothing, and a great many real types declare nothing.
  const named = type?.name?.trim().toLowerCase();
  const seeded: Record<string, CanonicalKind> = {
    task: "task",
    event: "event",
    text: "note",
    note: "note",
    person: "person",
    contact: "person",
    project: "project",
    organization: "organization",
    // British spelling kept deliberately: this is somebody else's type name,
    // not our prose. A library whose type is called "Organisation" must still
    // be recognized, and a spelling sweep that reaches data breaks exactly this.
    organisation: "organization",
    company: "organization",
  };
  if (named && seeded[named]) return seeded[named]!;

  // Weaker structural signals, below the name on purpose. Plenty of things carry
  // dates without being events — a project with a start and an end most
  // obviously — so this must not outrank a type whose name says what it is.
  if (has("datespan") || has("datetime")) return "event";

  // A person is the one shape that reliably points at an organization. Checked
  // before the org itself, since an organization can carry a reference too (to
  // its parent) and would otherwise swallow it.
  if (fields.some((f) => f.kind === "reference" && /organi[sz]ation|company|employer/i.test(f.key)))
    return "person";
  if (fields.some((f) => f.kind === "reference" && /parent/i.test(f.key))) return "organization";

  return "other";
}
