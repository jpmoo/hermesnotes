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
    patch: (a) => ({ ...a, nextOccurrence: (s, i, e) => a.nextOccurrence({ ...s, anchorDay: undefined }, i, e) }),
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
