/*
 * `@hermes/shared`, narrowed to what the canvas actually uses.
 *
 * The package is Hermes' own and pulling it in would be the build-time coupling
 * the brief rules out. What the canvas needs from it is small and stated here.
 */

/** A filter, in the shape the query builder produces. */
export interface FilterGroup {
  op: "and" | "or";
  rules: unknown[];
  groups: FilterGroup[];
}

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
