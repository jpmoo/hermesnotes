import type { PropertySchema } from "@hermes/shared";
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
 * Seeded types are recognised by name first, because that is exactly right for
 * the default install and costs nothing. Everything else is read off structure.
 * Anything that matches nothing is `other`: indexed, searchable, openable, but
 * without bespoke Siri grammar — which fails gracefully rather than invisibly.
 */
export function kindOf(
  typeName: string | null,
  schema: PropertySchema | null | undefined,
  opts: { builtin?: boolean; isText?: boolean; collectionKind?: string | null } = {},
): CanonicalKind {
  if (opts.collectionKind) return "other";
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
