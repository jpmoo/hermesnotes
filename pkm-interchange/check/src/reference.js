import { isComplete, profilesOf, read } from "./profiles.js";
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

  const next = structuredClone(object);
  next.properties = { ...(next.properties ?? {}) };
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

/**
 * Ordering tokens compare byte-wise. Under a language-aware collation "Zz" sorts
 * before "a0" and the top of every list is wrong.
 */
export function order(members) {
  return [...members]
    .sort((a, b) => (String(a.position) < String(b.position) ? -1 : String(a.position) > String(b.position) ? 1 : 0))
    .map((m) => m.object ?? m.id);
}

export const adapter = {
  validate,
  profilesOf,
  read,
  isComplete,
  order,
  nextOccurrence,
  import: importEnvelope,
  roundtrip,
  patch,
  follow,
};
