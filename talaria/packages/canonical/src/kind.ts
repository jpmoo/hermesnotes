import { declaresProfile, type PropertySchema } from "@hermes/shared";
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
  typeName: string | null,
  schema: PropertySchema | null | undefined,
  opts: { builtin?: boolean; isText?: boolean; collectionKind?: string | null } = {},
): { kind: CanonicalKind; derived: boolean } {
  if (opts.collectionKind) return { kind: "other", derived: false };

  // Declared beats everything, including the shape. A type that says it is a
  // task is a task even if its status field was removed this morning.
  //
  // Read straight off the schema rather than through profilesOf, which derives
  // `task` from status_field — a derived profile is the guess this branch exists
  // to avoid laundering into a declaration.
  for (const [name, kind] of BY_PROFILE) {
    if (declaresProfile(schema, name)) return { kind, derived: false };
  }

  return { kind: derive(typeName, schema, opts), derived: true };
}

export function kindOf(
  typeName: string | null,
  schema: PropertySchema | null | undefined,
  opts: { builtin?: boolean; isText?: boolean; collectionKind?: string | null } = {},
): CanonicalKind {
  return resolveKind(typeName, schema, opts).kind;
}

/** Everything below here is the guess, kept until declaring is the norm. */
function derive(
  typeName: string | null,
  schema: PropertySchema | null | undefined,
  opts: { builtin?: boolean; isText?: boolean; collectionKind?: string | null } = {},
): CanonicalKind {
  if (opts.isText) return "note";

  const fields = schema?.fields ?? [];
  const has = (t: string) => fields.some((f) => f.type === t);
  const completes = Boolean(schema?.status_field && schema.complete_values?.length);

  // Strongest signal first, and it doesn't care what the type is called: a thing
  // that can be finished is a task. This is what keeps a renamed Task working.
  if (completes) return "task";

  // Then the name, against the kinds Hermes seeds. Deliberately NOT limited to
  // `builtin` types: the seeding migrations skip any user who already made a
  // type of that name, so someone who built their own Project before the
  // built-in arrived has a Project that is user data — the common case, not the
  // odd one. The name is their own vocabulary and it is the best evidence
  // available when the shape says nothing.
  const named = typeName?.trim().toLowerCase();
  const seeded: Record<string, CanonicalKind> = {
    task: "task",
    event: "event",
    text: "note",
    note: "note",
    person: "person",
    contact: "person",
    project: "project",
    organization: "organization",
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
  if (fields.some((f) => f.type === "reference" && /organi[sz]ation|company|employer/i.test(f.key)))
    return "person";
  if (fields.some((f) => f.type === "reference" && /parent/i.test(f.key))) return "organization";

  return "other";
}
