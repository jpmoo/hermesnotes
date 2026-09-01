import { META_KEYS, isComplete, profilesOf, read } from "./profiles.js";
import { nextOccurrence } from "./recurrence.js";
import { validate } from "./validate.js";

/**
 * A reference consumer.
 *
 * It exists to prove the suite is executable and to be copied. The interesting
 * part is not that it keeps everything — that would be trivial — but *how*: it
 * holds the original document and overlays its own model on top, so anything it
 * never understood is still there in its original order when it writes back.
 * An implementation that decomposes an object into its own fields and
 * reassembles one on the way out will lose fields, order, or both, and will pass
 * its own tests while doing it.
 *
 * `capabilities` lets one implementation be tested as if it were many: a tool
 * with no board, no query engine, no archive. That is what turns "import into a
 * tool with no matrix view" from a sentence into a test.
 */

const KNOWN_TOP = new Set([
  "format", "producer", "conformance", "types", "objects", "collections", "series", "relations",
]);

export function importEnvelope(envelope, capabilities = {}) {
  const reports = [];
  const say = (what) => {
    if (!reports.includes(what)) reports.push(what);
  };

  // The original, untouched. Everything below is an overlay.
  const doc = structuredClone(envelope);

  for (const key of Object.keys(doc)) {
    if (!KNOWN_TOP.has(key)) say(`unknown-top-level:${key}`);
  }

  const objects = doc.objects ?? [];
  if (capabilities.archive === false && objects.some((o) => o.archived)) {
    // The flag survives regardless. The report is about what this tool can *act*
    // on: a reader here will see archived things among the live ones.
    say("archive");
  }
  if (capabilities.attachments === false) {
    const has = objects.some((o) =>
      Object.values(o.properties ?? {}).some((v) => v && typeof v === "object" && v.kind === "attachment"),
    );
    if (has) say("attachments");
  }
  if (capabilities.remapIds) {
    // Internal keys are fine; they just never leave. Rewriting ids on the way
    // out breaks every relation, membership and series reference anyone else is
    // holding, including the producer's own next sync.
    objects.forEach((o, i) => {
      o._internalId = i + 1;
    });
  }

  for (const c of doc.collections ?? []) {
    const semantic = c.placement?.semantic === true;
    if (semantic && capabilities.placement === false) {
      // The region is a judgment someone made, stored as a position. Keep the
      // value and say it cannot be shown.
      say("placement");
    }
    if (!semantic) {
      // Furniture: where something was dragged on one particular day. Dropping
      // it loses nothing, and reporting it here would train people to ignore the
      // report that matters.
      for (const m of c.members ?? []) if (m && typeof m === "object") delete m.context;
    }

    // Sort and grouping are derived, like a query's membership, and are lost the
    // same way. The list arrives looking correct — the positions are a snapshot
    // of the sorted order — which is exactly why silence here is the wrong
    // answer: it stops being correct the first time a due date moves.
    if (c.order?.sort && capabilities.sorting === false) say("order.sort");
    if (c.order?.groupBy && capabilities.grouping === false) say("order.grouping");

    const membership = c.membership ?? {};
    if (membership.mode === "query" && membership.materialized === false) {
      if (capabilities.query === false) {
        // Permitted — refusing the import helps nobody — but the user believes
        // they still have a live collection, so this is the one signal they get.
        say("query");
        c.membership = { mode: "explicit" };
      } else if (Array.isArray(capabilities.conditions)) {
        const unknown = (membership.query?.conditions ?? []).filter(
          (cond) => !capabilities.conditions.includes(cond.kind ?? "property"),
        );
        if (unknown.length) say("query.conditions");
      }
    }
  }

  const anchors = capabilities.series?.anchors;
  if (Array.isArray(anchors)) {
    for (const s of doc.series ?? []) {
      // Importing a completion-anchored rule as schedule-anchored produces a
      // task that looks right and drifts. The user finds out months later.
      if (!anchors.includes(s.rule?.anchor ?? "schedule")) say("series.anchor");
    }
  }

  {
    const byDay = new Map();
    for (const t of doc.types ?? []) {
      const key = t?.profiles?.journal?.date;
      if (!key) continue;
      for (const o of doc.objects ?? []) {
        if (o.type !== t.id) continue;
        const on = o.properties?.[key];
        if (on === undefined || on === "") continue;
        byDay.set(on, (byDay.get(on) ?? 0) + 1);
      }
    }
    // Not resolved here. Choosing between two pages for one day is a person's
    // decision, and choosing silently is how the one with the writing in it
    // ends up behind the empty one.
    if ([...byDay.values()].some((n) => n > 1)) say("journal.duplicate");
  }

  if (capabilities.hierarchy === false && (doc.objects ?? []).some((o) => o.parent !== undefined)) {
    // The keys survive — the round-trip rule does not bend for a consumer that
    // cannot use them — but the document arrives as a list, and the nesting is
    // what it was.
    say("hierarchy");
  }

  if (capabilities.relations === false && (doc.relations ?? []).length) say("relations");

  if (capabilities.references === "single") {
    const many = new Set(
      (doc.types ?? []).flatMap((t) => (t.fields ?? []).filter((f) => f.many).map((f) => `${t.id}.${f.key}`)),
    );
    // Taking the first and carrying on is allowed. Doing it quietly is not: the
    // user made that second relationship deliberately and has just lost it.
    const hit = (doc.objects ?? []).some((o) =>
      Object.entries(o.properties ?? {}).some(
        ([k, v]) => many.has(`${o.type}.${k}`) && Array.isArray(v) && v.length > 1,
      ),
    );
    if (hit) say("reference.cardinality");
  }

  const prose = (e) =>
    (e.types ?? []).some((t) => (t.fields ?? []).some((f) => f.kind === "richtext")) ||
    (e.objects ?? []).some((o) => Object.values(o.properties ?? {}).some((v) => typeof v === "string"));
  if (capabilities.richtext === false && prose(doc)) {
    // The writing comes back intact — nothing here takes a document apart — but
    // this tool cannot show it, and a reader here is missing the body of every
    // note.
    say("richtext");
  }
  if (capabilities.richtextRewrite && (doc.relations ?? []).some((r) => r.via === "inline")) {
    // The whole point of mirroring prose edges into relations. A tool that
    // rewrites markup cannot parse the dialect it is replacing, so it cannot
    // tell whether it just destroyed a link — but the mirror can tell it there
    // was one to destroy.
    say("richtext.mentions");
  }

  return { result: doc, fidelity: reports.length ? "reduced" : "full", reports };
}

/** Import then write back out. The document was never taken apart, so this is exact. */
export function roundtrip(envelope, capabilities = {}) {
  const imported = importEnvelope(envelope, capabilities);
  const out = structuredClone(imported.result);
  for (const o of out.objects ?? []) delete o._internalId;
  return { ...imported, result: out };
}

/**
 * Apply a partial write.
 *
 * The only two moves are `set` and `unset`, and everything the patch does not
 * name is left exactly as it was — including the properties this implementation
 * has never heard of. That is the round-trip rule at write time, and it is the
 * half that gets skipped: a tool can be scrupulous about an export and still
 * destroy a field the moment an agent changes a title.
 */
export function patch(object, p = {}, capabilities = {}) {
  const reports = [];
  const say = (what) => {
    if (!reports.includes(what)) reports.push(what);
  };

  // Versioned and stale: refuse. Merging is how one client's edit silently
  // reverts another's, with the writer told it landed.
  if (p.version !== undefined && object.version !== undefined && p.version !== object.version) {
    return { ok: false, conflict: true, object, fidelity: "full", reports: [] };
  }

  // A tag in both lists is a contradiction, and picking one silently is how a
  // board ends up tagged the opposite of what somebody asked for.
  const add = p.addTags ?? [];
  const drop = p.removeTags ?? [];
  const contradictory = add.filter((t) => drop.includes(t));
  if (contradictory.length) {
    return { ok: false, object, fidelity: "full", reports: ["tags.added-and-removed"] };
  }

  const next = structuredClone(object);
  next.properties = { ...(next.properties ?? {}) };

  // Named, never replaced. A whole-list write would delete every tag this
  // caller had not heard of, which is the round-trip rule broken on the field
  // most likely to be shared between tools.
  if (add.length || drop.length) {
    const tags = [...(next.tags ?? [])].filter((t) => !drop.includes(t));
    for (const t of add) if (!tags.includes(t)) tags.push(t);
    next.tags = tags;
  }
  for (const [k, v] of Object.entries(p.set ?? {})) {
    const anchors = capabilities.series?.anchors;
    if (Array.isArray(anchors) && v && typeof v === "object" && v.anchor && !anchors.includes(v.anchor)) {
      // Stored as given, but this server cannot act on that anchor. Answering a
      // bare `ok` here is how a caller learns nothing went wrong.
      say("series.anchor");
    }
    next.properties[k] = v;
  }
  for (const k of p.unset ?? []) delete next.properties[k];
  if (object.version !== undefined) next.version = object.version + 1;

  return { ok: true, object: next, fidelity: reports.length ? "reduced" : "full", reports };
}

/**
 * Bring an object into being, at an id the client chose.
 *
 * Creates and never edits, which is the whole reason it is a verb of its own
 * rather than a mode of `patch`. Replacing would discard every property the
 * caller had never heard of — the round-trip rule broken at write time, by the
 * verb least likely to be suspected of it — so an id already taken is answered
 * as a success that changed nothing.
 *
 * That is also what makes it safe to repeat. The client picked the id before it
 * sent anything, so a retry after a lost answer is recognizably the same create
 * rather than a second object.
 */
export function create(object = {}, ctx = {}) {
  const at = ctx.at ?? object.id;

  // Two ids in one request is a caller's bug, and choosing between them is how
  // an object is created somewhere nobody will look for it.
  if (object.id !== undefined && at !== undefined && object.id !== at) {
    return { ok: false, created: false, fidelity: "full", reports: ["create.id-mismatch"] };
  }

  // Already there. It succeeded once; this is the caller asking again because
  // it never heard so. Leave the object exactly as it stands.
  if (ctx.existing) {
    return { ok: true, created: false, object: ctx.existing, fidelity: "full", reports: [] };
  }

  // Declared, not merely named. A create is the one write with no earlier
  // version to compare against, so a reduction nobody mentions is invisible for
  // good.
  const declared = ctx.types ?? [];
  const known = Boolean(object.type) && declared.some((t) => t.id === object.type);

  return {
    ok: true,
    created: true,
    // Cloned, and every property kept — including the ones no type declares.
    // A producer that keeps only what it recognizes turns each create into a
    // lossy import, and the loss cannot be seen because there is nothing
    // earlier to compare it with.
    object: { ...structuredClone(object), id: at },
    fidelity: known ? "full" : "reduced",
    reports: known ? [] : ["create.unknown-type"],
  };
}

/**
 * Where a member sits, changed.
 *
 * The collection owns placement, so this is a write against the collection and
 * not a patch on the object — an object does not know which boards it is on and
 * must not have to.
 *
 * Two slots, and which one a collection uses is not a choice its members make.
 * `region` is a judgment somebody recorded and travels as a declared name;
 * `context` is furniture — canvas coordinates, a size somebody dragged, a
 * collapsed row — and travels as a bag of the producer's own keys. A collection
 * says which it is in `placement.semantic`, and writing the wrong one is refused
 * rather than stored: a coordinate on a semantic board is a judgment recorded
 * where nothing can read it, and a region name on a canvas names a region that
 * does not exist.
 *
 * `context` merges. This is the round-trip rule at write time and it is the half
 * that gets skipped: a tool that drags a card and sends `{x, y}` has never heard
 * of the `w`, `h` and color somebody else's tool put there, and a write that
 * replaced the bag would delete them. Removing a key has to be said out loud, in
 * `unset`, for the same reason it does on an object.
 */
export function place(collection, member, p = {}) {
  const semantic = collection?.placement?.semantic === true;
  const wantsContext = p.context !== undefined || (p.unset ?? []).length > 0;

  if (p.version !== undefined && member?.version !== undefined && p.version !== member.version) {
    return { ok: false, conflict: true, member, fidelity: "full", reports: [] };
  }

  if (wantsContext && semantic) {
    return { ok: false, member, fidelity: "full", reports: ["placement.coordinates-not-semantic"] };
  }

  if (p.region !== undefined && p.region !== null) {
    // Declared, not merely spelled. A region nothing renders is a card that has
    // silently vanished from the board, which is worse than a refusal because
    // nobody finds out.
    const names = (collection?.placement?.regions ?? []).map((r) => (typeof r === "string" ? r : r?.name));
    if (!names.includes(p.region)) {
      return { ok: false, member, fidelity: "full", reports: ["placement.region-not-declared"] };
    }
  }

  const next = structuredClone(member ?? {});
  if (p.region !== undefined) {
    if (p.region === null) delete next.region;
    else next.region = p.region;
  }
  if (wantsContext) {
    const bag = { ...(next.context ?? {}), ...(p.context ?? {}) };
    for (const k of p.unset ?? []) delete bag[k];
    // A member whose furniture has all been removed carries no bag at all,
    // rather than an empty one that a round-trip would then have to preserve as
    // a fact about nothing.
    if (Object.keys(bag).length) next.context = bag;
    else delete next.context;
  }
  if (member?.version !== undefined) next.version = member.version + 1;

  return { ok: true, member: next, fidelity: "full", reports: [] };
}

/**
 * A membership, made or unmade.
 *
 * Separate verbs from `place` and for the same reason `create` is separate from
 * `patch`: making a thing exist and changing it are different questions, and a
 * verb that does both cannot be repeated safely. A `put` at a membership that is
 * already there answers as the success it was, and changes nothing — the caller
 * is asking again because it never heard the first answer, not because it wants
 * the placement moved.
 *
 * A `delete` unmakes the *membership*. The object goes on existing, wherever
 * else it lives. This is the one place where the difference between removing
 * something from a list and destroying it has to be said in the verb, because a
 * caller that gets it wrong cannot undo it.
 */
export function member(collection, object, op, body = {}) {
  const members = collection?.members ?? [];
  const at = members.findIndex((m) => (typeof m === "string" ? m : m?.object) === object);
  const existing = at < 0 ? null : members[at];

  if (op === "delete") {
    // Not a member, and the caller wanted it not to be. That is the state it
    // asked for, so it is a success that changed nothing rather than a 404 the
    // caller has to special-case on every retry.
    if (!existing) return { ok: true, removed: false, fidelity: "full", reports: [] };
    return { ok: true, removed: true, fidelity: "full", reports: [] };
  }

  if (existing) {
    const was = typeof existing === "string" ? { object: existing } : structuredClone(existing);
    return { ok: true, created: false, member: was, fidelity: "full", reports: [] };
  }

  // A new membership arrives with its placement, so the same two rules apply as
  // they do to moving one. Checked by handing it to `place`, because two copies
  // of a rule is how one of them ends up being the older one.
  const placed = place(collection, { object }, body);
  if (!placed.ok) return { ...placed, created: false };
  return { ok: true, created: true, member: placed.member, fidelity: "full", reports: [] };
}

/**
 * A collection's own keys, changed.
 *
 * What this exists for is everything a collection carries that is not an object:
 * a canvas's sticky notes and the connections drawn between them, a table's
 * columns, saved view state. None of it can be written any other way, because
 * none of it is an object and `PATCH` on an object is the only other write.
 *
 * It writes `properties`, and only that. A collection's structural keys —
 * `kind`, `placement`, `members` — are not in that bag and so are unreachable
 * from here, which is better than a rule that refuses them: each has
 * consequences a generic write could not honour, and `members` is what the two
 * membership verbs are for.
 *
 * **Only prefixed names.** Unprefixed keys inside a collection's `properties`
 * belong to the format, and this is the door that rule had not been applied to.
 * Refused rather than ignored, because a caller told its write landed and then
 * finding the collection unchanged has no way to learn which happened.
 *
 * `set` and `unset`, with the same meaning they have on an object: a key named
 * by neither is untouched, including every key this implementation has never
 * heard of.
 */
export function patchCollection(collection, p = {}) {
  if (p.version !== undefined && collection?.version !== undefined && p.version !== collection.version) {
    return { ok: false, conflict: true, collection, fidelity: "full", reports: [] };
  }

  const named = [...Object.keys(p.set ?? {}), ...(p.unset ?? [])];
  const bare = named.filter((k) => !k.includes(":"));
  if (bare.length) {
    return { ok: false, collection, fidelity: "full", reports: ["collection.unprefixed-write"] };
  }

  const next = structuredClone(collection ?? {});
  const props = { ...(next.properties ?? {}) };
  for (const [k, v] of Object.entries(p.set ?? {})) props[k] = v;
  for (const k of p.unset ?? []) delete props[k];
  next.properties = props;
  if (collection?.version !== undefined) next.version = collection.version + 1;

  return { ok: true, collection: next, fidelity: "full", reports: [] };
}

/**
 * A collection brought into being.
 *
 * The same verb as a create on an object, one noun along, and it exists for the
 * same reason: a client that keeps its own document somewhere has to be able to
 * make the container the first time it runs, and asking again after a lost
 * answer must not make a second one.
 *
 * The client chooses the id, which is what makes a repeat recognizable as a
 * repeat rather than as a new board.
 *
 * Creates and never edits. A create at an id already taken is a success that
 * changed nothing — replacing would discard every key the caller had never
 * heard of, which is the round-trip rule broken at write time by the verb least
 * likely to be suspected of it.
 */
export function createCollection(collection = {}, ctx = {}) {
  const at = ctx.at ?? collection.id;

  if (collection.id !== undefined && at !== undefined && collection.id !== at) {
    return { ok: false, created: false, fidelity: "full", reports: ["create.id-mismatch"] };
  }

  // Already there. It succeeded once; this is the caller asking again because
  // it never heard so.
  if (ctx.existing) {
    return { ok: true, created: false, collection: ctx.existing, fidelity: "full", reports: [] };
  }

  // The prefix rule reaches this door too.
  //
  // `collectionPatch` refuses an unprefixed key because unprefixed names belong
  // to the format. A create that did not would be the way around it: make the
  // collection with `sort_mode` already on it and no write ever has to be
  // refused. Same rule, and the one place it would otherwise have a gap.
  const bare = Object.keys(collection.properties ?? {}).filter((k) => !k.includes(":"));
  if (bare.length) {
    return { ok: false, created: false, fidelity: "full", reports: ["collection.unprefixed-write"] };
  }

  // Members are a separate write, and not out of tidiness. Joining a collection
  // can tag a card, move it, or change its status — a region declares what it
  // does to what lands in it — and a bag of ids carried along with a create
  // cannot say whether any of that ran. Refused rather than dropped, because a
  // caller whose members vanished silently would believe the board was full.
  if (Array.isArray(collection.members) && collection.members.length) {
    return { ok: false, created: false, fidelity: "full", reports: ["collection.members-are-a-separate-write"] };
  }

  return {
    ok: true,
    created: true,
    // Everything kept, including whatever this implementation has never heard
    // of — a create is the one write with no earlier version to compare
    // against, so a reduction nobody mentions is invisible for good.
    collection: { ...structuredClone(collection), id: at },
    fidelity: "full",
    reports: [],
  };
}

/**
 * What a follower concludes from a change feed.
 *
 * Rows arrive in order and the last one about an object is the current one — in
 * both directions. A delete that outranks every later row is the bug that makes
 * a dragged card disappear: a card moving between columns is a membership
 * removed and re-added, and a feed reporting the child row's own operation calls
 * that a deletion.
 */
export function follow(feed = []) {
  const state = new Map();
  for (const row of [...feed].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) {
    state.set(row.object, row.op === "delete" ? "gone" : "alive");
  }
  return {
    alive: [...state].filter(([, v]) => v === "alive").map(([id]) => id),
    gone: [...state].filter(([, v]) => v === "gone").map(([id]) => id),
  };
}

/** An empty string is not a value here either. */
const missing = (v) => v === undefined || v === null || v === "";

/**
 * One sortable value, named the way a profile mapping names a field.
 *
 * `{field}` and `{field, part}` are the shape profiles already use, reused
 * rather than reinvented. `{meta}` is the escape hatch for the handful of things
 * that are not in the property bag, and it is a separate key rather than a
 * reserved word so that a producer whose user named a field `type` — which is a
 * matter of time, since types here are rows somebody can rename — does not
 * collide with it.
 */
export function valueAt(object, by, types = []) {
  if (!by || typeof by !== "object") return undefined;
  if (by.meta !== undefined) {
    if (!META_KEYS.has(by.meta)) return undefined;
    // A type sorts by the name on the heading, not by the id under it. Grouping
    // wants the opposite and gets it below, from the raw value: a group key has
    // to survive somebody renaming the type.
    if (by.meta === "type" && by.sortByName) {
      return (types ?? []).find((t) => t.id === object?.type)?.name ?? object?.type;
    }
    return object?.[by.meta];
  }
  if (typeof by.field !== "string") return undefined;
  const v = object?.properties?.[by.field];
  if (v === null || v === undefined) return undefined;
  return by.part ? v?.[by.part] : v;
}

/** Byte-wise unless both are numbers — the same rule `position` states. */
function compareValues(a, b) {
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
  const [x, y] = [String(a), String(b)];
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Compare two objects on one sort key.
 *
 * Direction is applied to the comparison and deliberately *not* to the
 * missing-value rule: absent sorts last in both directions, because a person
 * sorting by due date descending wants the furthest-out dated thing at the top
 * and the undated ones out of the way. Folding missing into the reversal is the
 * bug this is written out longhand to avoid.
 */
function compareOn(a, b, spec, types) {
  const by = spec?.by?.meta === "type" ? { ...spec.by, sortByName: true } : spec?.by;
  const [x, y] = [valueAt(a, by, types), valueAt(b, by, types)];
  const [mx, my] = [missing(x), missing(y)];
  if (mx || my) return mx && my ? 0 : mx ? 1 : -1;
  const c = compareValues(x, y);
  return spec?.direction === "descending" ? -c : c;
}

/**
 * What order to show a collection in.
 *
 * Ordering tokens compare byte-wise. Under a language-aware collation "Zz" sorts
 * before "a0" and the top of every list is wrong.
 *
 * Answers ids in order, or groups of them when the collection says to group.
 * Two shapes for one question because they are one question: a consumer asking
 * for the arrangement wants the buckets and the order inside them together, and
 * splitting it into two calls leaves them to re-derive how the two interact.
 */
export function order(collection, objects = [], types = []) {
  const members = (collection?.members ?? []).map((m) => (typeof m === "string" ? { object: m } : m));
  const byId = new Map((objects ?? []).map((o) => [o.id, o]));
  const spec = collection?.order ?? {};

  // Stored order first, always. It is the answer when there is no sort, and the
  // last resort when there is: a sort naming no tiebreak is not thereby
  // unstable, because the producer's order decides rather than whichever pair
  // the consumer's sort algorithm happened to touch first.
  const stored = [...members].sort((a, b) =>
    compareValues(String(a.position ?? ""), String(b.position ?? "")),
  );

  const sorts = Array.isArray(spec.sort) ? spec.sort : [];
  const arrange = (list) =>
    !sorts.length
      ? list
      : [...list].sort((a, b) => {
          for (const s of sorts) {
            const c = compareOn(byId.get(a.object), byId.get(b.object), s, types);
            if (c) return c;
          }
          // Zero, and the list is already in stored order — a stable sort does
          // the rest. This is the tiebreak, not an absence of one.
          return 0;
        });

  if (!spec.groupBy) return arrange(stored).map((m) => m.object ?? m.id);

  const buckets = new Map();
  for (const m of stored) {
    const raw = valueAt(byId.get(m.object), spec.groupBy);
    // An object that cannot be grouped is still a member. It gets a group rather
    // than being dropped, which is how somebody loses work they can still see in
    // the tool they exported from.
    const key = missing(raw) ? null : raw;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(m);
  }
  return {
    groups: [...buckets.entries()]
      .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : compareValues(a, b)))
      .map(([key, list]) => ({ key, members: arrange(list).map((m) => m.object ?? m.id) })),
  };
}

/**
 * The outline: roots in order, each with its children in order.
 *
 * Built from parent pointers rather than from any list of children, because a
 * parent pointer cannot disagree with itself. A `children` array on the parent
 * and a `parent` on the child are two statements of one fact, and the day they
 * differ there is no way to tell which is the document.
 *
 * An object whose parent is not here stands at the root. A `since` read is a
 * delta and will routinely carry a child whose parent has not changed — losing
 * it would lose somebody's writing over a detail of transport, and inventing a
 * placeholder parent would put a node in their outline that they did not write.
 */
export function outline(objects = []) {
  const present = new Set(objects.map((o) => o.id));
  const byParent = new Map();
  for (const o of objects) {
    const key = o.parent !== undefined && present.has(o.parent) ? o.parent : null;
    byParent.set(key, [...(byParent.get(key) ?? []), o]);
  }
  // Byte-wise, like every other ordering token here. A language-aware collation
  // puts "Zz" after "a0" and the top of the outline is wrong.
  const sorted = (list) =>
    [...list].sort((a, b) => {
      const [x, y] = [String(a.position ?? ""), String(b.position ?? "")];
      return x < y ? -1 : x > y ? 1 : 0;
    });
  const build = (parent) =>
    sorted(byParent.get(parent) ?? []).map((o) => ({ id: o.id, children: build(o.id) }));
  return build(null);
}

/**
 * The page for a date, or nothing.
 *
 * A journal object is found by its declared profile and its mapped field, never
 * by the shape of its title. A note called "2026-08-30" is a note somebody
 * named after a day; the producer says which types are journals by declaring
 * the profile, and that is the only evidence there is.
 *
 * Answers nothing for a date nobody has opened. Producers create these lazily,
 * so most dates have no page, and the nearest one is somebody else's day.
 */
export function journalFor(types = [], objects = [], date) {
  const journals = new Set(
    types.filter((t) => t?.profiles?.journal?.date).map((t) => t.id),
  );
  const byId = new Map(types.map((t) => [t.id, t]));
  const hits = objects.filter((o) => {
    if (!journals.has(o.type)) return false;
    const key = byId.get(o.type).profiles.journal.date;
    return o.properties?.[key] === date;
  });
  return hits.length ? hits[0].id : null;
}

export const adapter = {
  // It exists to stand in for other tools, so it can be asked to lack anything.
  simulates: ["*"],
  // And it claims everything, so nothing is scoped away from it. A real
  // implementation declares what it actually does and is measured on that.
  conformance: {
    profiles: ["task", "event", "contact", "note", "journal"],
    features: ["series", "placement", "derivations", "relations", "attachments", "addresses", "ordering", "hierarchy"],
  },
  validate,
  profilesOf,
  read,
  isComplete,
  order,
  outline,
  journalFor,
  nextOccurrence,
  import: importEnvelope,
  roundtrip,
  patch,
  create,
  place,
  member,
  patchCollection,
  createCollection,
  follow,
};
