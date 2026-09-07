/*
 * `@hermes/shared`, narrowed to what the canvas actually uses.
 *
 * The package is Hermes' own and pulling it in would be the build-time coupling
 * the brief rules out. What the canvas needs from it is small and stated here.
 */

/**
 * One test in a filter.
 *
 * Hermes declares this as a discriminated union of a dozen members — tag,
 * property, text, semantic, created, edited — and the canvas inspects none of
 * them: it carries a filter from the collection to the daemon and back. So this
 * says what is actually relied on, which is that a condition has a `kind` and is
 * otherwise its own business.
 */
export interface Condition {
  kind: string;
  [key: string]: unknown;
}

/**
 * A group of conditions and nested groups, combined by `match`.
 *
 * The shape is Hermes' own — `packages/shared/src/collections.ts` — restated
 * rather than imported, because importing it is the build-time coupling the
 * brief rules out. Restating means it can drift, so it is written to match
 * exactly and `lib/filter.ts` is the thing that would notice: it builds one of
 * these by hand.
 *
 * The first version of this shim invented `{op, rules, groups}` and nothing
 * caught it, because the type checker had never been run over the fork and
 * `vite build` does not typecheck. Every use of it was already writing
 * `{kind, match, items}`.
 */
export type FilterGroup = {
  kind: "group";
  match: "all" | "any";
  items: Array<Condition | FilterGroup>;
};

/**
 * Which property holds a type's body text.
 *
 * Hermes derives it from the type's schema; Talaria's canvas never edits a
 * block's body — a placed block is a title, an icon and a completion box — so
 * this answers the one thing callers do with it.
 */
export function bodyFieldKey(_type: unknown): string | null {
  return null;
}
