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

  const named = typeName?.trim().toLowerCase();
  if (opts.builtin && named) {
    const seeded: Record<string, CanonicalKind> = {
      task: "task",
      event: "event",
      text: "note",
      note: "note",
      person: "person",
      project: "project",
      organization: "organization",
    };
    const hit = seeded[named];
    if (hit) return hit;
  }

  if (opts.isText) return "note";

  const fields = schema?.fields ?? [];
  const has = (t: string) => fields.some((f) => f.type === t);
  const completes = Boolean(schema?.status_field && schema.complete_values?.length);

  // A thing that can be finished and can be scheduled is a task, whatever it is
  // called. The status field is what distinguishes it from an event: an event
  // happens whether or not you do anything about it.
  if (completes && (has("datespan") || has("datetime") || has("date"))) return "task";
  if (completes) return "task";
  if (has("datespan") || has("datetime")) return "event";

  // A person is the one shape that reliably points at an organization. Checked
  // before the org itself, since an organization can also carry a reference (to
  // its parent) and would otherwise swallow it.
  if (fields.some((f) => f.type === "reference" && /organi[sz]ation|company|employer/i.test(f.key)))
    return "person";
  if (fields.some((f) => f.type === "reference" && /parent/i.test(f.key))) return "organization";

  return "other";
}
