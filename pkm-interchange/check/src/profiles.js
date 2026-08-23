/** The v0 profile vocabulary. Anything else is preserved and ignored. */
export const V0_PROFILES = ["task", "event", "contact", "note"];

/**
 * Which v0 profiles a type declares, in the order it declared them.
 *
 * A type with no declaration returns nothing, and that is an answer rather than
 * a prompt to go looking: a Recipe with a `status` field whose options include
 * `done` is still not a task, and the only thing that could have said otherwise
 * is the producer.
 */
export function profilesOf(type) {
  const declared = type?.profiles ?? {};
  return Object.keys(declared).filter((p) => V0_PROFILES.includes(p));
}

/**
 * One value, read through a profile rather than off a field name.
 *
 * A mapping is either a field key or `{field, part}` for the half of a compound
 * field a profile wants — one producer's single datespan is the task profile's
 * `start` and `due` both, and the labels on it are the producer's own words, not
 * a vocabulary to match against.
 */
export function read(type, object, key, profile = "task") {
  const map = type?.profiles?.[profile];
  if (!map) return undefined;
  const spec = map[key];
  if (spec === undefined || spec === null) return undefined;
  const props = object?.properties ?? {};
  if (typeof spec === "string") return props[spec];
  if (typeof spec === "object" && spec.field) {
    const v = props[spec.field];
    if (v === null || v === undefined) return undefined;
    return spec.part ? v?.[spec.part] : v;
  }
  return undefined;
}

/**
 * Whether an object is finished.
 *
 * Completion is a set of values, not one: a producer for whom "abandoned" ends a
 * task is telling you something true about their model, and a consumer that
 * treats only the last option as done will show them work they have closed.
 */
export function isComplete(type, object) {
  const map = type?.profiles?.task;
  if (!map?.status) return false;
  const value = read(type, object, "status", "task");
  const complete = map.completeValues ?? [];
  return complete.includes(value);
}
