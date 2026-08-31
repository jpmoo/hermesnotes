/**
 * The three writes a collection owns.
 *
 * A collection owns where its members sit, which members it has, and everything
 * on it that is not an object — a canvas's sticky notes, a table's columns. None
 * of those is a property of anything, so none of them can be written by patching
 * an object, which is why they are here rather than in `import.ts`.
 *
 * Vocabulary rather than storage. Each function takes the interchange shapes and
 * answers what the format says should happen; the binding then carries out the
 * accepted write against Hermes' own routes. Keeping the decision here is what
 * lets the fixtures measure it: an adapter that reimplemented these rules on the
 * way to the suite would be testing the adapter.
 */

export interface WriteMember {
  object?: string;
  region?: string;
  position?: string;
  context?: Record<string, unknown>;
  version?: number;
}

export interface WriteCollection {
  id?: string;
  kind?: string;
  placement?: { semantic?: boolean; regions?: (string | { name?: string })[] };
  members?: (WriteMember | string)[];
  version?: number;
  [key: string]: unknown;
}

export interface PlacePatch {
  region?: string | null;
  context?: Record<string, unknown>;
  unset?: string[];
  version?: number;
}

export interface PropsPatch {
  set?: Record<string, unknown>;
  unset?: string[];
  version?: number;
}

const idOf = (m: WriteMember | string) => (typeof m === "string" ? m : m.object);

const regionNames = (c: WriteCollection | undefined) =>
  (c?.placement?.regions ?? []).map((r) => (typeof r === "string" ? r : r?.name));

/**
 * Where a member sits, changed.
 *
 * Two slots, and the collection says which of them applies. `region` is a
 * judgment somebody recorded and travels as a name the collection declared;
 * `context` is furniture — coordinates, a size somebody dragged — and travels as
 * a bag. Writing the wrong one is refused rather than stored, because a judgment
 * kept as a coordinate is a judgment nothing can read back, and stored-and-
 * unreadable looks exactly like success.
 *
 * `context` merges. A tool that drags a card sends the two numbers it moved and
 * has never heard of the size and colour another tool put there; replacing the
 * bag would delete them and answer ok. Removing a key is said out loud in
 * `unset`, for the reason it is on an object: absent means absent.
 */
export function placeMember(
  collection: WriteCollection | undefined,
  member: WriteMember | undefined,
  patch: PlacePatch = {},
): { ok: boolean; conflict?: boolean; member?: WriteMember; fidelity: "full"; reports: string[] } {
  const semantic = collection?.placement?.semantic === true;
  const touchesContext = patch.context !== undefined || (patch.unset ?? []).length > 0;

  if (patch.version !== undefined && member?.version !== undefined && patch.version !== member.version) {
    return { ok: false, conflict: true, member, fidelity: "full", reports: [] };
  }

  if (touchesContext && semantic) {
    return { ok: false, member, fidelity: "full", reports: ["placement.coordinates-not-semantic"] };
  }

  if (patch.region !== undefined && patch.region !== null) {
    // Declared, not merely spelled. A region nothing renders is a card that has
    // vanished from the board with nobody told, which is worse than a refusal.
    if (!regionNames(collection).includes(patch.region)) {
      return { ok: false, member, fidelity: "full", reports: ["placement.region-not-declared"] };
    }
  }

  const next: WriteMember = { ...(member ?? {}) };
  if (patch.region !== undefined) {
    if (patch.region === null) delete next.region;
    else next.region = patch.region;
  }
  if (touchesContext) {
    const bag = { ...(next.context ?? {}), ...(patch.context ?? {}) };
    for (const k of patch.unset ?? []) delete bag[k];
    // A member whose furniture has all been removed carries no bag rather than
    // an empty one — a fact about nothing that a round-trip would then have to
    // preserve forever.
    if (Object.keys(bag).length) next.context = bag;
    else delete next.context;
  }
  if (member?.version !== undefined) next.version = member.version + 1;

  return { ok: true, member: next, fidelity: "full", reports: [] };
}

/**
 * A membership, made or unmade.
 *
 * The same division `PUT` and `PATCH` draw on an object: making a thing exist
 * and changing it are different questions, and a verb that did both could not be
 * retried after a timeout without dragging somebody's card back to where it was
 * five minutes ago. A `put` at a membership already there answers as the success
 * it was and changes nothing.
 *
 * `delete` unmakes the membership. The object goes on existing wherever else it
 * lives — the one write where that difference is carried entirely by the verb.
 * Removing something already gone is a success, because it is the state the
 * caller asked for and a replaying queue cannot know which of its writes landed.
 */
export function memberWrite(
  collection: WriteCollection | undefined,
  object: string,
  op: "put" | "delete",
  body: PlacePatch = {},
): {
  ok: boolean;
  created?: boolean;
  removed?: boolean;
  member?: WriteMember;
  fidelity: "full";
  reports: string[];
} {
  const existing = (collection?.members ?? []).find((m) => idOf(m) === object);

  if (op === "delete") {
    if (!existing) return { ok: true, removed: false, fidelity: "full", reports: [] };
    return { ok: true, removed: true, fidelity: "full", reports: [] };
  }

  if (existing) {
    const was = typeof existing === "string" ? { object: existing } : { ...existing };
    return { ok: true, created: false, member: was, fidelity: "full", reports: [] };
  }

  // A new membership arrives with its placement, so the same two rules apply as
  // on a move — checked by asking `placeMember`, because two copies of a rule is
  // how one of them ends up being the older one.
  const placed = placeMember(collection, { object }, body);
  if (!placed.ok) return { ...placed, created: false };
  return { ok: true, created: true, member: placed.member, fidelity: "full", reports: [] };
}

/**
 * A collection's own keys, changed.
 *
 * **Only prefixed ones.** An unprefixed name belongs to the format, and that one
 * rule lands in the right place by itself: `kind`, `placement` and `members` are
 * all unprefixed, and each has rules a generic bag cannot honour — changing a
 * kind reinterprets every member's placement, and emptying `members` is what the
 * membership verbs are for. Refused rather than ignored, because a caller told
 * its write landed and then finding nothing changed has no way to learn which of
 * the two happened.
 */
export function patchCollectionProps(
  collection: WriteCollection | undefined,
  patch: PropsPatch = {},
): { ok: boolean; conflict?: boolean; collection?: WriteCollection; fidelity: "full"; reports: string[] } {
  if (patch.version !== undefined && collection?.version !== undefined && patch.version !== collection.version) {
    return { ok: false, conflict: true, collection, fidelity: "full", reports: [] };
  }

  const named = [...Object.keys(patch.set ?? {}), ...(patch.unset ?? [])];
  if (named.some((k) => !k.includes(":"))) {
    return { ok: false, collection, fidelity: "full", reports: ["collection.unprefixed-write"] };
  }

  const next: WriteCollection = { ...(collection ?? {}) };
  for (const [k, v] of Object.entries(patch.set ?? {})) next[k] = v;
  for (const k of patch.unset ?? []) delete next[k];
  if (collection?.version !== undefined) next.version = collection.version + 1;

  return { ok: true, collection: next, fidelity: "full", reports: [] };
}
