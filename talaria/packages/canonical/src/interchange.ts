/**
 * Reading a type you have never seen.
 *
 * Talaria's own implementation of the profile vocabulary, deliberately not
 * imported from Hermes. Sharing that code would have made the two apps agree by
 * construction, which is the one way to be certain a format is doing no work —
 * a binding proves nothing when both ends are the same package.
 *
 * Everything here is `pkm-interchange/0`. Nothing in it knows what a Hermes is.
 */

export interface InterchangeField {
  key: string;
  kind?: string;
  label?: string;
  options?: { value: string; label?: string }[] | string[];
  startLabel?: string;
  endLabel?: string;
  many?: boolean;
  targetType?: string;
}

/** A profile entry: a field key, the reserved body slot, or half a compound field. */
export type Mapping = string | { field: string; part?: string };

export interface InterchangeType {
  id: string;
  name?: string;
  fields?: InterchangeField[];
  profiles?: Record<string, Record<string, unknown>>;
  /** Producer annotations ride along; none of them are read for meaning. */
  [key: string]: unknown;
}

export interface InterchangeObject {
  id: string;
  type?: string;
  properties?: Record<string, unknown>;
  content?: string;
  tags?: string[];
  archived?: boolean;
  created?: string;
  updated?: string;
  version?: number;
  series?: string;
  /**
   * Where a person can go to see this, as the producer says it.
   *
   * Opaque, like an id. Not to be rewritten, not to be pattern-matched, and
   * never to be synthesised for an object that lacks one — absent means this
   * producer publishes no address for this thing, which is a different fact
   * from an address that went missing.
   *
   * Talaria built this string itself until the format grew a place to put it:
   * `{origin}/block/{id}`, which is one producer's routing scheme hardcoded
   * into a consumer, and which would have sent somebody nowhere against
   * anything but Hermes.
   */
  url?: string;
  [key: string]: unknown;
}

/**
 * A region is a name, or a name and the words a person reads.
 *
 * The name is what a member matches on and what a write names; the label is for
 * display and carries no meaning. A bare string is both at once, which is right
 * whenever the two agree — and wrong the moment somebody writes "Delegate &
 * Wait", which slugs to something no reader should ever be shown.
 */
export type Region = string | { name: string; label?: string };

export const regionName = (r: Region): string => (typeof r === "string" ? r : r.name);
export const regionLabel = (r: Region): string =>
  typeof r === "string" ? r : (r.label ?? r.name);

export interface InterchangeCollection {
  id: string;
  name?: string;
  kind?: string;
  /** Where a person can go to see this board. Opaque; see `InterchangeObject.url`. */
  url?: string;
  properties?: Record<string, unknown>;
  placement?: { semantic?: boolean; regions?: Region[] };
  membership?: { mode?: string; materialized?: boolean; query?: unknown };
  members?: { object?: string; position?: string; region?: string; context?: Record<string, unknown> }[];
}

export interface Envelope {
  format?: string;
  cursor?: string;
  producer?: { name?: string; version?: string };
  conformance?: Conformance;
  types?: InterchangeType[];
  objects?: InterchangeObject[];
  collections?: InterchangeCollection[];
  series?: { id: string; rule?: Record<string, unknown> }[];
  relations?: { from?: string; to?: string; type?: string; via?: string; field?: string }[];
  changes?: { object: string; op: string; cause?: string }[];
  findings?: { code: string; detail?: string; count?: number }[];
}

export interface Conformance {
  produce?: number;
  consume?: number;
  operate?: number;
  bindings?: string[];
  profiles?: string[];
  features?: string[];
  unsupported?: string[];
}

/** The v0 vocabulary. A profile outside it is carried and never interpreted. */
export const V0_PROFILES = ["task", "event", "contact", "note"] as const;
export type ProfileName = (typeof V0_PROFILES)[number];

/** Which v0 profiles a type declares. Absence is an answer, not a prompt to guess. */
export function profilesOf(type: InterchangeType | undefined): ProfileName[] {
  const declared = type?.profiles ?? {};
  return (V0_PROFILES as readonly string[]).filter((p) => declared[p]) as ProfileName[];
}

export function declares(type: InterchangeType | undefined, profile: ProfileName): boolean {
  return Boolean(type?.profiles?.[profile]);
}

/** An empty string is not a value. Real libraries are full of fields opened and left alone. */
const blank = (v: unknown): unknown => (v === "" ? undefined : v);

/**
 * One value, read through a profile rather than off a field name.
 *
 * `content` is the one reserved name outside the property bag — a document with
 * a body and some metadata about it is the dominant shape here, and a format
 * where everything must be a property has nowhere to put the body.
 */
export function read(
  type: InterchangeType | undefined,
  object: InterchangeObject | undefined,
  key: string,
  profile: ProfileName = "task",
): unknown {
  const spec = type?.profiles?.[profile]?.[key] as Mapping | undefined;
  if (spec === undefined || spec === null) return undefined;
  if (spec === "content") return blank(object?.content);
  const props = object?.properties ?? {};
  if (typeof spec === "string") return blank(props[spec]);
  if (typeof spec === "object" && typeof spec.field === "string") {
    const v = props[spec.field];
    if (v === null || v === undefined) return undefined;
    return blank(spec.part ? (v as Record<string, unknown>)[spec.part] : v);
  }
  return undefined;
}

/** Which field a profile slot resolves to, for the times the field itself is wanted. */
export function fieldFor(
  type: InterchangeType | undefined,
  key: string,
  profile: ProfileName = "task",
): InterchangeField | null {
  const spec = type?.profiles?.[profile]?.[key] as Mapping | undefined;
  const name = typeof spec === "string" ? spec : typeof spec === "object" ? spec.field : undefined;
  if (!name || name === "content") return null;
  return (type?.fields ?? []).find((f) => f.key === name) ?? null;
}

/**
 * Whether an object is finished.
 *
 * Completion is a set of values, not one: a producer for whom "abandoned" ends a
 * task is saying something true about their model, and a consumer that treats
 * only the last option as done shows people work they have closed.
 */
export function isComplete(type: InterchangeType | undefined, object: InterchangeObject): boolean {
  const map = type?.profiles?.task;
  if (!map?.status) return false;
  const complete = (map.completeValues ?? []) as string[];
  return complete.includes(String(read(type, object, "status", "task") ?? ""));
}

/** Whether this type has a completion model at all — a thing that can be ticked. */
export function completable(type: InterchangeType | undefined): boolean {
  const map = type?.profiles?.task;
  return Boolean(map?.status && ((map.completeValues ?? []) as string[]).length);
}

/** How a stored value should read, using the producer's own label for it. */
export function optionLabel(field: InterchangeField | null, value: string): string {
  for (const o of field?.options ?? []) {
    if (typeof o === "string") {
      if (o === value) return o;
    } else if (o.value === value) {
      return o.label ?? o.value;
    }
  }
  return value;
}
