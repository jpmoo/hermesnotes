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
    // A collection answered on its own, as a list of ids. Current, and useless
    // to the one consumer that had to ask — the one that cannot run the query.
    name: "answers a collection read with ids it does not carry the objects for",
    caught: "operational/a-collection-read-carries-its-members",
    patch: (a) => ({
      ...a,
      validate: (env) => {
        const got = a.validate(env);
        const errors = got.errors.filter((e) => e.code !== "collection.member-not-carried");
        return { valid: errors.length === 0, errors };
      },
    }),
  },
  {
    // The obvious shortcut, and the one that appends to somebody's meeting
    // notes: find the daily page by matching a title against a date.
    name: "finds the daily page by its title rather than its declared profile",
    caught: "journal/only-a-journal-type-answers",
    patch: (a) => ({
      ...a,
      journalFor: (types, objects, date) =>
        objects.find((o) => Object.values(o.properties ?? {}).includes(date))?.id ?? null,
    }),
  },
  {
    // Two pages for one day, one of them picked in silence. The one with the
    // writing in it is the one that disappears.
    name: "picks a page when a date has two, without saying so",
    caught: "journal/duplicates-are-reported-not-resolved",
    patch: (a) => ({
      ...a,
      import: (env, caps) => {
        const out = a.import(env, caps);
        const reports = out.reports.filter((r) => r !== "journal.duplicate");
        return { ...out, reports, fidelity: reports.length ? "reduced" : "full" };
      },
    }),
  },
  {
    // A date nobody has opened, answered with the nearest page there is.
    // Somebody's writing lands under the wrong day.
    name: "answers a date with no page using the closest one it has",
    caught: "journal/a-day-nobody-has-opened",
    patch: (a) => ({
      ...a,
      journalFor: (types, objects, date) => {
        const hit = a.journalFor(types, objects, date);
        if (hit) return hit;
        const journals = new Set(types.filter((t) => t?.profiles?.journal?.date).map((t) => t.id));
        return objects.find((o) => journals.has(o.type))?.id ?? null;
      },
    }),
  },
  {
    // The outliner bug everyone writes once: sort siblings with the language's
    // own comparison. "Zz" lands after "a0" and the top of the outline is wrong.
    name: "orders siblings by locale rather than byte-wise",
    caught: "hierarchy/siblings-sort-byte-wise",
    patch: (a) => ({
      ...a,
      outline: (objects) => {
        const collated = [...objects].sort((x, y) =>
          String(x.position ?? "").localeCompare(String(y.position ?? "")),
        );
        // Positions rewritten in collated order, so the reference's own byte-wise
        // sort reproduces the locale one.
        return a.outline(collated.map((o, i) => ({ ...o, position: String(i).padStart(4, "0") })));
      },
    }),
  },
  {
    // A child whose parent is not in this payload, dropped. Looks tidy and
    // silently loses writing on every delta read, which is most reads.
    name: "drops an object whose parent is not in the payload",
    caught: "hierarchy/a-missing-parent-is-a-root-for-now",
    patch: (a) => ({
      ...a,
      outline: (objects) => {
        const present = new Set(objects.map((o) => o.id));
        return a.outline(objects.filter((o) => o.parent === undefined || present.has(o.parent)));
      },
    }),
  },
  {
    // Cycle detection that looks only one step up. Catches a self-parent and
    // walks forever on any longer loop — which is the case that matters.
    name: "only notices a cycle when an object is its own parent",
    caught: "hierarchy/a-cycle-is-invalid",
    patch: (a) => ({
      ...a,
      validate: (env) => {
        const got = a.validate(env);
        const real = (env.objects ?? []).some((o) => o.parent === o.id);
        const errors = got.errors.filter((e) => e.code !== "hierarchy.cycle" || real);
        return { valid: errors.length === 0, errors };
      },
    }),
  },
  {
    // Flattened without a word. The list looks fine; the document is gone.
    name: "flattens an outline without reporting it",
    caught: "hierarchy/flattening-must-be-reported",
    patch: (a) => ({
      ...a,
      import: (env, caps) => a.import(env, { ...caps, hierarchy: undefined }),
    }),
  },
  {
    // Keys a flat tool has no use for, tidied away on the way out. Opening
    // somebody's outline in the wrong application destroys it.
    name: "a flattener drops parent and position on re-export",
    caught: "hierarchy/a-flattener-still-gives-it-back",
    patch: (a) => ({
      ...a,
      roundtrip: (env, caps) => {
        const out = a.roundtrip(env, caps);
        if (caps.hierarchy === false) {
          for (const o of out.result.objects ?? []) {
            delete o.parent;
            delete o.position;
          }
        }
        return out;
      },
    }),
  },
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
    // recognized as one, so a queue draining on a bad network leaves two.
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
    name: "normalizes prose into its own markup",
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
    // Rewritten when its target was. It used to drop relations carrying
    // `resolved: false`, and the format had since removed that flag outright —
    // a join a consumer can do in one pass, and a second version of a fact
    // otherwise. So the mutant attacked a field nothing emitted and could not
    // fail, which is the same shape as the dangling name it was found by.
    //
    // The mistake in the model as it stands is tidier and more tempting: an
    // object with no type does not look like a real object, so a consumer
    // sweeps it up — and every sentence naming it now points at nothing.
    name: "tidies away the stub an unwritten name became",
    caught: "inline/a-name-with-no-thing-is-a-stub",
    patch: (a) => ({
      ...a,
      roundtrip: (env, caps) => {
        const out = a.roundtrip(env, caps);
        out.result.objects = (out.result.objects ?? []).filter((o) => o.stub !== true);
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
  {
    // The obvious create, and the one that empties a board every time a client
    // restarts — because the check-and-create at startup *is* a repeat.
    name: "a collection create replaces the collection already there",
    caught: "membership/repeating-a-collection-create-is-not-a-second-board",
    patch: (a) => ({
      ...a,
      createCollection: (col, ctx) => ({
        ok: true,
        created: true,
        collection: { ...col, id: ctx.at ?? col.id },
        fidelity: "full",
        reports: [],
      }),
    }),
  },
  {
    // Keeps only what it recognizes. Invisible, because a create has nothing
    // earlier to be compared against.
    name: "a collection create keeps only the keys it knows",
    caught: "membership/a-collection-can-be-brought-into-being",
    patch: (a) => ({
      ...a,
      createCollection: (col, ctx) => {
        const out = a.createCollection(col, ctx);
        if (out.ok && out.created) out.collection = { id: out.collection.id, kind: out.collection.kind };
        return out;
      },
    }),
  },
  {
    // The way around the prefix rule: never refuse a write, just let the key
    // arrive at creation instead.
    name: "takes an unprefixed key when the collection is being created",
    caught: "membership/a-created-collection-cannot-take-an-unprefixed-key",
    patch: (a) => ({
      ...a,
      createCollection: (col, ctx) => {
        const bare = Object.keys(col?.properties ?? {}).filter((k) => !k.includes(":"));
        if (bare.length) {
          return { ok: true, created: true, collection: { ...col, id: ctx.at ?? col.id }, fidelity: "full", reports: [] };
        }
        return a.createCollection(col, ctx);
      },
    }),
  },
  {
    // Members dropped rather than refused. The board comes back empty and the
    // client was told it worked.
    name: "drops the members a create was given instead of refusing them",
    caught: "membership/members-do-not-arrive-with-a-collection",
    patch: (a) => ({
      ...a,
      createCollection: (col, ctx) => {
        const { members, ...rest } = col ?? {};
        return a.createCollection(rest, ctx);
      },
    }),
  },
  {
    // The check that costs nothing, passes its own tests, and can never fire.
    // A producer in this state looks safer than one that versions nothing at
    // all, and is less safe: a client sends a version and believes it is
    // protected, and every write lands whatever it sent.
    name: "honours a member version on the write and never issues one on the read",
    caught: "membership/a-move-answers-with-the-next-version",
    patch: (a) => ({
      ...a,
      place: (col, m, p) => {
        const out = a.place(col, m, p);
        if (out.ok && out.member) delete out.member.version;
        return out;
      },
    }),
  },
  {
    // A board that can be moved once. The second drag sends the number the
    // first one was answered with, which is now stale, and is refused — so the
    // card springs back and nothing says why.
    name: "answers a placement with the version it was given rather than the one it wrote",
    caught: "membership/a-move-answers-with-the-next-version",
    patch: (a) => ({
      ...a,
      place: (col, m, p) => {
        const out = a.place(col, m, p);
        if (out.ok && out.member && m?.version !== undefined) out.member.version = m.version;
        return out;
      },
    }),
  },
  {
    // Refusing on a number nobody keeps. The mirror image of the first: a
    // producer with no membership versions that rejects a hopeful client's
    // guess, which makes it impossible to write through rather than merely
    // unprotected.
    name: "refuses a version against a membership it does not version",
    caught: "membership/an-unversioned-membership-accepts-anything",
    patch: (a) => ({
      ...a,
      place: (col, m, p) => {
        if (p?.version !== undefined && m?.version === undefined) {
          return { ok: false, conflict: true, member: m, fidelity: "full", reports: [] };
        }
        return a.place(col, m, p);
      },
    }),
  },
  {
    // The obvious implementation of a placement write, and the one that loses
    // the size and the color every time somebody drags a card two pixels.
    name: "replaces a member's furniture instead of merging into it",
    caught: "membership/context-merges",
    patch: (a) => ({
      ...a,
      place: (col, m, p) => {
        const out = a.place(col, m, p);
        if (out.ok && p.context) out.member.context = { ...p.context };
        return out;
      },
    }),
  },
  {
    // A bag emptied down to `{}` rather than removed. Harmless-looking, and it
    // makes an export that no longer round-trips against the one before it.
    name: "leaves an empty bag behind when the last key is removed",
    caught: "membership/furniture-can-be-emptied-completely",
    patch: (a) => ({
      ...a,
      place: (col, m, p) => {
        const out = a.place(col, m, p);
        if (out.ok && out.member.context === undefined) out.member.context = {};
        return out;
      },
    }),
  },
  {
    // Stores the coordinate on a board that keeps meaning in named regions.
    // Nothing errors, nothing renders, and the judgment is gone.
    name: "stores a coordinate written to a semantic collection",
    caught: "membership/coordinates-refused-on-semantic-placement",
    patch: (a) => ({
      ...a,
      place: (col, m, p) => a.place({ ...col, placement: { ...col.placement, semantic: false } }, m, p),
    }),
  },
  {
    // The region write with its one check removed: a card lands in a region the
    // board never declared, which is a card nothing draws.
    name: "stores a region the collection never declared",
    caught: "membership/region-must-be-one-the-collection-declared",
    patch: (a) => ({
      ...a,
      place: (col, m, p) =>
        a.place(
          { ...col, placement: { ...col.placement, regions: [...(col.placement?.regions ?? []), p.region] } },
          m,
          p,
        ),
    }),
  },
  {
    // `PUT` implemented as an upsert. Reads as a convenience; means a retry
    // after a timeout silently moves a card somebody has since dragged.
    name: "lets a repeated membership write move the card",
    caught: "membership/put-again-changes-nothing",
    patch: (a) => ({
      ...a,
      member: (col, object, op, body) =>
        op === "put"
          ? a.member({ ...col, members: (col.members ?? []).filter((m) => (typeof m === "string" ? m : m?.object) !== object) }, object, op, body)
          : a.member(col, object, op, body),
    }),
  },
  {
    // Not-a-member answered as not-found. Every offline client then has to
    // special-case its own retries, which is where the duplicates come from.
    name: "answers not-found when asked to remove something already gone",
    caught: "membership/delete-again-is-a-success",
    patch: (a) => ({
      ...a,
      member: (col, object, op, body) => {
        const out = a.member(col, object, op, body);
        if (op === "delete" && !out.removed) return { ...out, ok: false, reports: ["member.not-a-member"] };
        return out;
      },
    }),
  },
  {
    // A producer taking a name out of the format's namespace through the one
    // door the prefix rule had not been applied to.
    name: "accepts an unprefixed key on a collection write",
    caught: "membership/a-collections-own-keys-must-be-prefixed",
    patch: (a) => ({
      ...a,
      patchCollection: (col, p) => {
        const prefixed = (o) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k.includes(":") ? k : `hermes:${k}`, v]));
        return a.patchCollection(col, { ...p, set: prefixed(p.set), unset: (p.unset ?? []).map((k) => (k.includes(":") ? k : `hermes:${k}`)) });
      },
    }),
  },
  {
    // The payload treated as the whole collection — the same bug as "treats a
    // patch as the whole object", on the write where the casualties are another
    // producer's keys.
    name: "treats a collection write as the whole collection",
    caught: "membership/a-collection-write-leaves-the-rest-alone",
    patch: (a) => ({
      ...a,
      patchCollection: (col, p) => {
        const out = a.patchCollection(col, p);
        if (out.ok) out.collection = { ...out.collection, properties: { ...(p.set ?? {}) } };
        return out;
      },
    }),
  },
];

let escaped = 0;
for (const m of MUTANTS) {
  const results = runSuites(m.patch(reference), FIXTURES);
  const target = results.find((r) => r.id === m.caught);
  const others = results.filter((r) => r.id !== m.caught && !r.pass).map((r) => r.id);
  // A mutant naming a case that no longer exists.
  //
  // `find` answers undefined, `undefined?.pass` is falsy, and the else branch
  // below then prints "caught" — so renaming a fixture silently turned one of
  // these into a mutant nothing was checking, and the total kept saying every
  // one was caught. Exactly the failure this suite exists to find, in the suite
  // itself. Loud, and counted as an escape, because that is what it is.
  if (!target) {
    escaped += 1;
    console.log(`ESCAPED  ${m.name}`);
    console.log(`         names "${m.caught}", which is not a case in the fixtures`);
  } else if (target.pass) {
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
