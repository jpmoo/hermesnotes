#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adapter as reference } from "./reference.js";
import { runSuites } from "./runner.js";

/**
 * Does the suite have teeth?
 *
 * A fixture set that goes green on the first run has told you nothing until you
 * know it can go red. Each mutant below is a plausible wrong implementation —
 * every one of them is a real bug someone has shipped — paired with the case
 * that must catch it. A mutant nothing catches is a hole in the fixtures, and
 * this file is how the hole gets found before an implementer does.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");

const MUTANTS = [
  {
    // The obvious reading of "sort by type", and the one that puts a list in an
    // order with no visible logic: type ids are uuids in most producers, so the
    // headings come out shuffled and every user reports it as a bug in sorting.
    name: "sorts by type id rather than by the type's name",
    caught: "sort/type-sorts-by-name-not-id",
    patch: (a) => ({
      ...a,
      order: (collection, objects, types) => a.order(collection, objects, []),
    }),
  },
  {
    // The one every implementation decides silently and differently. Reversing
    // the whole comparison — missing values included — is what you get for free
    // from `-compare(a, b)`, and it puts every undated task at the top of a list
    // sorted by due date descending.
    name: "reverses missing values along with everything else when sorting descending",
    caught: "sort/missing-sorts-last-descending",
    patch: (a) => ({
      ...a,
      order: (collection, objects) => {
        const spec = (collection?.order?.sort ?? [])[0];
        if (!spec || collection?.order?.groupBy) return a.order(collection, objects);
        const flat = { ...collection, order: { sort: [{ ...spec, direction: "ascending" }] } };
        const asc = a.order(flat, objects);
        return spec.direction === "descending" ? [...asc].reverse() : asc;
      },
    }),
  },
  {
    // The stored order thrown away rather than kept as the last resort. Passes
    // every case with distinct values and reorders equal ones by whatever the
    // engine's sort happened to do, which differs between runtimes and is not
    // stable in all of them.
    name: "does not fall back to position when two objects sort equal",
    caught: "sort/ties-fall-to-position",
    patch: (a) => ({
      ...a,
      order: (collection, objects) =>
        a.order(
          {
            ...collection,
            members: (collection?.members ?? []).map((m) =>
              typeof m === "string" ? m : { ...m, position: undefined },
            ),
          },
          objects,
        ),
    }),
  },
  {
    // `part` ignored and the whole compound value compared instead. A datespan
    // object stringifies to something with the start in it, so sorting by the
    // end of a span quietly sorts by its start.
    name: "sorts on a compound field whole, ignoring which half was named",
    caught: "sort/compound-part",
    patch: (a) => ({
      ...a,
      order: (collection, objects) =>
        a.order(
          {
            ...collection,
            order: collection?.order && {
              ...collection.order,
              sort: (collection.order.sort ?? []).map((sp) => ({ ...sp, by: { field: sp.by?.field } })),
            },
          },
          (objects ?? []).map((o) => ({
            ...o,
            properties: Object.fromEntries(
              Object.entries(o.properties ?? {}).map(([k, v]) => [
                k, v && typeof v === "object" && !Array.isArray(v) ? JSON.stringify(v) : v,
              ]),
            ),
          })),
        ),
    }),
  },
  {
    // Grouping applied after a global sort rather than inside each bucket. Same
    // members, same groups, and the order under each heading is wrong.
    name: "drops members whose grouping key is missing",
    caught: "sort/missing-group-key-is-null-group",
    patch: (a) => ({
      ...a,
      order: (collection, objects) => {
        const got = a.order(collection, objects);
        if (!got?.groups) return got;
        return { groups: got.groups.filter((g) => g.key !== null) };
      },
    }),
  },
  {
    // The arrangement dropped without a word. The list arrives looking right,
    // because the positions are a snapshot of the sorted order, and stops being
    // right the first time a due date moves.
    name: "drops a sort it cannot run without reporting it",
    caught: "sort/consumer-without-sorting",
    patch: (a) => ({
      ...a,
      import: (env, caps) => a.import(env, { ...caps, sorting: undefined }),
    }),
  },
  {
    // The obvious wrong implementation, and the one the verb exists to prevent:
    // treat the tags a caller named as the caller's whole intended list. Every
    // tag the writer had never heard of disappears, silently, on a write that
    // looked like it was only adding one.
    name: "a tag write replaces the list instead of amending it",
    caught: "tags/add-leaves-the-others",
    patch: (a) => ({
      ...a,
      patch: (object, p, caps) => {
        const out = a.patch(object, p, caps);
        if (p?.addTags || p?.removeTags) out.object.tags = [...(p.addTags ?? [])];
        return out;
      },
    }),
  },
  {
    // Idempotence dropped: a repeat becomes an error, so every reconnect
    // surfaces failures for work that already succeeded.
    name: "adding a tag that is already present is treated as an error",
    caught: "tags/adding-one-already-there-is-not-an-error",
    patch: (a) => ({
      ...a,
      patch: (object, p, caps) =>
        (p?.addTags ?? []).some((t) => (object.tags ?? []).includes(t))
          ? { ok: false, object, fidelity: "full", reports: ["tags.duplicate"] }
          : a.patch(object, p, caps),
    }),
  },
  {
    // The failure the whole verb was shaped around: PUT read as "make the
    // resource have this state" rather than "make it exist". It looks correct,
    // it is what PUT means elsewhere, and it destroys every property the caller
    // never knew about — silently, on a retry nobody thought was a write.
    name: "a create replaces the object already there",
    caught: "create/an-existing-object-is-not-replaced",
    patch: (a) => ({
      ...a,
      create: (object, ctx) =>
        ctx.existing
          ? { ok: true, created: false, object: { ...ctx.existing, ...object }, fidelity: "full", reports: [] }
          : a.create(object, ctx),
    }),
  },
  {
    // The other half. An id minted at the server means a repeat cannot be
    // recognised as one, so a queue draining on a bad network leaves two.
    name: "a create mints its own id and makes a second object",
    caught: "create/repeating-a-create-is-not-a-second-object",
    patch: (a) => ({
      ...a,
      create: (object, ctx) => a.create(object, { ...ctx, existing: null }),
    }),
  },
  {
    name: "clamp re-anchors to the shorter month",
    caught: "recurrence/monthly-clamp-does-not-reanchor",
    // Advance from the last occurrence's day rather than the rule's. The rule
    // now carries the day, so forgetting it means ignoring `byMonthDay` too.
    patch: (a) => ({
      ...a,
      nextOccurrence: (s, i, e) =>
        a.nextOccurrence({ ...s, anchorDay: undefined, rule: { ...s.rule, byMonthDay: undefined } }, i, e),
    }),
  },
  {
    name: "drops regions it cannot draw",
    caught: "placement/semantic-must-survive",
    patch: (a) => ({
      ...a,
      import: (env, caps) => {
        const out = a.import(env, caps);
        if (caps.placement === false) {
          for (const c of out.result.collections ?? []) for (const m of c.members ?? []) delete m.region;
        }
        return out;
      },
    }),
  },
  {
    name: "reports reduced fidelity for furniture",
    caught: "placement/view-may-be-dropped",
    patch: (a) => ({
      ...a,
      import: (env, caps) => ({ ...a.import(env, caps), fidelity: "reduced", reports: ["placement"] }),
    }),
  },
  {
    name: "renumbers ids on the way out",
    caught: "roundtrip/no-id-rewriting",
    patch: (a) => ({
      ...a,
      roundtrip: (env, caps) => {
        const out = a.roundtrip(env, caps);
        (out.result.objects ?? []).forEach((o, i) => {
          o.id = `local-${i}`;
        });
        return out;
      },
    }),
  },
  {
    name: "imports completion-anchored recurrence quietly",
    caught: "conformance/silent-coercion-is-a-failure",
    patch: (a) => ({ ...a, import: (env, caps) => a.import(env, { ...caps, series: undefined }) }),
  },
  {
    name: "freezes a live query into an explicit list",
    caught: "derivation/query-members-are-not-authoritative",
    patch: (a) => ({
      ...a,
      roundtrip: (env, caps) => {
        const out = a.roundtrip(env, caps);
        for (const c of out.result.collections ?? []) {
          if (c.membership?.mode === "query") c.membership = { mode: "explicit" };
        }
        return out;
      },
    }),
  },
  {
    name: "infers task-ness from field names",
    caught: "profile/no-declaration-no-guessing",
    patch: (a) => ({
      ...a,
      profilesOf: (t) => {
        const declared = a.profilesOf(t);
        if (declared.length) return declared;
        return (t?.fields ?? []).some((f) => f.key === "status") ? ["task"] : [];
      },
    }),
  },
  {
    name: "strips properties its schema has no room for",
    caught: "roundtrip/unknown-property-survives",
    patch: (a) => ({
      ...a,
      roundtrip: (env, caps) => {
        const out = a.roundtrip(env, caps);
        for (const o of out.result.objects ?? []) {
          o.properties = Object.fromEntries(
            Object.entries(o.properties ?? {}).filter(([k]) => ["title", "status", "dates"].includes(k)),
          );
        }
        return out;
      },
    }),
  },
  {
    name: "sorts ordering tokens with a locale-aware comparison",
    caught: "placement/position-is-opaque",
    patch: (a) => ({
      ...a,
      order: (members) =>
        [...members].sort((x, y) => String(x.position).localeCompare(String(y.position))).map((m) => m.object ?? m.id),
    }),
  },
  {
    name: "normalises prose into its own markup",
    caught: "inline/prose-is-opaque",
    patch: (a) => ({
      ...a,
      roundtrip: (env, caps) => {
        const out = a.roundtrip(env, caps);
        for (const o of out.result.objects ?? []) {
          for (const [k, v] of Object.entries(o.properties ?? {})) {
            if (typeof v === "string") o.properties[k] = v.replace(/\(\((\w+)\)\)/g, "[[$1]]");
          }
        }
        return out;
      },
    }),
  },
  {
    name: "drops inline edges it cannot find in the prose",
    caught: "inline/mirrored-edge-survives-prose-blindness",
    patch: (a) => ({
      ...a,
      roundtrip: (env, caps) => {
        const out = a.roundtrip(env, caps);
        out.result.relations = (out.result.relations ?? []).filter((r) => r.via !== "inline");
        return out;
      },
    }),
  },
  {
    name: "flattens typed edges into untyped backlinks",
    caught: "inline/inline-edge-is-not-a-backlink",
    patch: (a) => ({
      ...a,
      roundtrip: (env, caps) => {
        const out = a.roundtrip(env, caps);
        out.result.relations = (out.result.relations ?? []).map((r) => ({ from: r.from, to: r.to }));
        return out;
      },
    }),
  },
  {
    name: "tidies away mentions whose target has gone",
    caught: "inline/unresolved-mention-survives",
    patch: (a) => ({
      ...a,
      roundtrip: (env, caps) => {
        const out = a.roundtrip(env, caps);
        out.result.relations = (out.result.relations ?? []).filter((r) => r.resolved !== false);
        return out;
      },
    }),
  },
  {
    name: "rewrites prose without saying so",
    caught: "inline/rewriting-prose-must-report",
    patch: (a) => ({
      ...a,
      import: (env, caps) => a.import(env, { ...caps, richtextRewrite: false }),
    }),
  },
  {
    name: "mints a fresh id when a stub becomes real",
    caught: "inline/resolving-a-stub-keeps-its-id",
    patch: (a) => ({
      ...a,
      roundtrip: (env, caps) => {
        const out = a.roundtrip(env, caps);
        for (const o of out.result.objects ?? []) if (o.type) o.id = `${o.id}-v2`;
        return out;
      },
    }),
  },
  {
    name: "tidies a stub down to a bare id",
    caught: "inline/a-name-with-no-thing-is-a-stub",
    patch: (a) => ({
      ...a,
      roundtrip: (env, caps) => {
        const out = a.roundtrip(env, caps);
        for (const o of out.result.objects ?? []) if (o.stub) delete o.properties;
        return out;
      },
    }),
  },
  {
    name: "takes the first of many references and carries on",
    caught: "values/one-holder-must-say-so",
    patch: (a) => ({ ...a, import: (env, caps) => a.import(env, { ...caps, references: undefined }) }),
  },
  {
    name: "reads an empty string as a value",
    caught: "values/an-empty-string-is-not-a-value",
    patch: (a) => ({
      ...a,
      read: (t, o, k, p) => {
        const spec = t?.profiles?.[p ?? "task"]?.[k];
        if (spec && typeof spec === "object" && spec.field) {
          return (o?.properties ?? {})[spec.field]?.[spec.part];
        }
        return a.read(t, o, k, p);
      },
    }),
  },
  {
    name: "drops a field whose kind it has never heard of",
    caught: "values/an-unknown-kind-is-carried",
    patch: (a) => ({
      ...a,
      roundtrip: (env, caps) => {
        const known = ["text","richtext","number","boolean","url","date","datetime","datespan","enum","reference","attachment"];
        const out = a.roundtrip(env, caps);
        for (const t of out.result.types ?? []) t.fields = (t.fields ?? []).filter((f) => known.includes(f.kind));
        return out;
      },
    }),
  },
  {
    name: "accepts a list in a field declared single",
    caught: "values/a-single-reference-is-not-a-list",
    patch: (a) => ({ ...a, validate: (e) => {
      const got = a.validate(e);
      const kept = got.errors.filter((x) => x.code !== "value.cardinality");
      return { valid: kept.length === 0, errors: kept };
    } }),
  },
  {
    name: "treats a patch as the whole object",
    caught: "operational/absent-is-not-delete",
    patch: (a) => ({
      ...a,
      patch: (obj, p, caps) => {
        const out = a.patch(obj, p, caps);
        if (out.ok) out.object.properties = { ...(p.set ?? {}) };
        return out;
      },
    }),
  },
  {
    name: "drops properties its schema has no room for on write",
    caught: "operational/patch-leaves-unknowns-alone",
    patch: (a) => ({
      ...a,
      patch: (obj, p, caps) => {
        const out = a.patch(obj, p, caps);
        if (out.ok) {
          out.object.properties = Object.fromEntries(
            Object.entries(out.object.properties).filter(([k]) => ["title", "status", "owner"].includes(k)),
          );
        }
        return out;
      },
    }),
  },
  {
    name: "merges a stale patch instead of refusing it",
    caught: "operational/stale-patch-is-refused",
    patch: (a) => ({ ...a, patch: (obj, p, caps) => a.patch(obj, { ...p, version: undefined }, caps) }),
  },
  {
    name: "answers ok for a write it could not fully store",
    caught: "operational/write-that-loses-something-says-so",
    patch: (a) => ({ ...a, patch: (obj, p, caps) => a.patch(obj, p, { ...caps, series: undefined }) }),
  },
  {
    name: "lets a delete outrank everything after it",
    caught: "operational/last-word-wins",
    patch: (a) => ({
      ...a,
      follow: (feed) => {
        const gone = new Set(feed.filter((r) => r.op === "delete").map((r) => r.object));
        const all = a.follow(feed);
        return {
          alive: [...all.alive, ...all.gone].filter((id) => !gone.has(id)),
          gone: [...gone],
        };
      },
    }),
  },
  {
    name: "reports a membership removal as a deleted object",
    caught: "operational/child-change-is-an-object-update",
    patch: (a) => ({ ...a, validate: (e) => {
      const got = a.validate(e);
      return { ...got, errors: got.errors.filter((x) => x.code !== "changes.child-op"),
               valid: got.errors.every((x) => x.code === "changes.child-op") };
    } }),
  },
  {
    name: "takes a profile's word for it",
    caught: "profile/mapping-names-a-real-field",
    // The shape of every level-1 implementation that reads through a mapping
    // without ever asking whether the mapping lands: the export is well-formed,
    // the profile is spelled correctly, and the due date is undefined.
    patch: (a) => ({ ...a, validate: (e) => {
      const got = a.validate(e);
      const kept = got.errors.filter((x) => x.code !== "profile.field-not-declared");
      return { valid: kept.length === 0, errors: kept };
    } }),
  },
  {
    name: "narrows a read by filtering types and objects separately",
    caught: "operational/a-narrowed-read-carries-its-types",
    // The obvious way to implement `?profile=task`: filter the types, filter
    // the objects, ship both. Correct until an object survives whose type did
    // not, which is every object the narrowing was meant to exclude.
    patch: (a) => ({ ...a, validate: (e) => {
      const got = a.validate(e);
      const kept = got.errors.filter((x) => x.code !== "object.type-not-declared");
      return { valid: kept.length === 0, errors: kept };
    } }),
  },
  {
    name: "accepts a semantic placement given as coordinates",
    caught: "placement/semantic-requires-named-regions",
    patch: (a) => ({ ...a, validate: () => ({ valid: true, errors: [] }) }),
  },
];

let escaped = 0;
for (const m of MUTANTS) {
  const results = runSuites(m.patch(reference), FIXTURES);
  const target = results.find((r) => r.id === m.caught);
  const others = results.filter((r) => r.id !== m.caught && !r.pass).map((r) => r.id);
  if (target?.pass) {
    escaped += 1;
    console.log(`ESCAPED  ${m.name}`);
    console.log(`         nothing failed in ${m.caught}`);
  } else {
    const also = others.length ? `  (also caught by ${others.length} other case${others.length > 1 ? "s" : ""})` : "";
    console.log(`caught   ${m.name}${also}`);
  }
}

console.log(`\n${MUTANTS.length - escaped}/${MUTANTS.length} mutants caught`);
process.exit(escaped ? 1 : 0);
