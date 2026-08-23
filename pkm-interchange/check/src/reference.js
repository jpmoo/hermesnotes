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
};
