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
