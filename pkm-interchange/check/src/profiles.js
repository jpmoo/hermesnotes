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
  // The one reserved name outside the property bag. A document with a body and
  // some metadata about it is the dominant shape in this genre, and a format
  // where everything must be a property has nowhere to put the body.
  if (spec === "content") return blank(object?.content);
  if (typeof spec === "string") return blank(props[spec]);
  if (typeof spec === "object" && spec.field) {
    const v = props[spec.field];
    if (v === null || v === undefined) return undefined;
    return blank(spec.part ? v?.[spec.part] : v);
  }
  return undefined;
}

/**
 * An empty string is not a value.
 *
 * Real libraries are full of them, where a field was opened and left alone. The
 * format used to say both ends of a span were optional without saying what ""
 * meant, so one consumer read no start and another read a start that failed to
 * parse and showed the epoch.
 */
const blank = (v) => (v === "" ? undefined : v);

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
