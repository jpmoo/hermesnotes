import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Run the fixtures against an adapter.
 *
 * The adapter is the whole contract between this and an implementation: eight
 * operations, listed in fixtures/README.md. Anything that can answer them can be
 * checked, whether it is a library, a file, or a server behind HTTP.
 */

/** A case hands over a fragment; every op works on a whole envelope. */
function envelopeOf(given) {
  const e = given.export ? structuredClone(given.export) : {};
  const push = (key, value) => {
    e[key] = [...(e[key] ?? []), value];
  };
  if (given.types) e.types = [...(e.types ?? []), ...given.types];
  if (given.type) push("types", given.type);
  if (given.objects) e.objects = [...(e.objects ?? []), ...given.objects];
  if (given.object) push("objects", given.object);
  if (given.collections) e.collections = [...(e.collections ?? []), ...given.collections];
  if (given.collection) push("collections", given.collection);
  if (given.relations) e.relations = [...(e.relations ?? []), ...given.relations];
  if (given.members) push("collections", { members: given.members });
  if (given.series) {
    for (const s of Array.isArray(given.series) ? given.series : [given.series]) push("series", s);
  }
  if (given.rule) {
    push("series", {
      rule: given.rule,
      ...(given.horizon !== undefined ? { horizon: given.horizon } : {}),
      ...(given.instances ? { instances: given.instances } : {}),
    });
  }
  return e;
}

/**
 * Which part of the result a case is talking about.
 *
 * A case may say outright with `of`. Left unsaid, it is inferred from what the
 * case handed over: one object means the expectation is about that object, and
 * anything else means the whole export. Inference is a convenience — a case
 * whose `given` holds several things should say which one it means, because
 * guessing from the shape of the input is how a fixture ends up asserting
 * something other than what it reads as asserting.
 */
function slice(given, envelope, of) {
  const pick = of ?? (given.collection || given.members ? "collection" : given.object ? "object" : "envelope");
  if (pick === "collection") return (envelope.collections ?? [])[0];
  if (pick === "object") return (envelope.objects ?? [])[0];
  return envelope;
}

/**
 * `expect` is a subset, so a case says only what it is about.
 *
 * Arrays inside a result are matched loosely — every expected element must be
 * found somewhere — because a case that names one member should not also be
 * asserting how many there are or what order they came in. A bare expected
 * value, on the other hand, is the whole answer and is compared exactly.
 */
function subset(expected, actual) {
  if (expected === null || typeof expected !== "object") return Object.is(expected, actual);
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    return expected.every((want) => actual.some((got) => subset(want, got)));
  }
  if (actual === null || typeof actual !== "object") return false;
  return Object.entries(expected).every(([k, v]) => subset(v, actual[k]));
}

const exact = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function runCase(adapter, c, bySuiteId) {
  const given = c.inherit ? { ...bySuiteId.get(c.inherit).given, ...c.given } : c.given;
  const env = envelopeOf(given);
  const caps = c.with ?? {};
  const typeOf = (obj) =>
    (env.types ?? []).find((t) => t.id === obj?.type) ?? (env.types ?? [])[0];

  switch (c.op) {
    case "validate": {
      const got = adapter.validate(env);
      const okValid = got.valid === c.expect.valid;
      const codes = (got.errors ?? []).map((e) => e.code);
      const okCodes = (c.expect.errors ?? []).every((e) => codes.includes(e.code));
      return { pass: okValid && okCodes, got };
    }
    case "profilesOf": {
      const got = adapter.profilesOf((env.types ?? [])[0]);
      return { pass: exact(got, c.expect), got };
    }
    case "read": {
      const obj = (env.objects ?? [])[0];
      const got = adapter.read(typeOf(obj), obj, c.args.key);
      return { pass: exact(got, c.expect), got };
    }
    case "isComplete": {
      const obj = (env.objects ?? [])[0];
      const got = adapter.isComplete(typeOf(obj), obj);
      return { pass: got === c.expect, got };
    }
    case "order": {
      const got = adapter.order(((env.collections ?? [])[0] ?? {}).members ?? []);
      return { pass: exact(got, c.expect), got };
    }
    case "nextOccurrence": {
      const s = (env.series ?? [])[0];
      let instance = given.instance;
      let got = adapter.nextOccurrence(s, instance, { completed: c.when?.completed });
      if (c.when?.thenCompleted && got) {
        // A second turn of the same series. The anchor stays with the series —
        // that is the whole content of "clamping must not re-anchor".
        const anchorDay = Number((given.instance?.due ?? "").slice(8, 10)) || undefined;
        got = adapter.nextOccurrence(
          { ...s, anchorDay, instances: [...(s.instances ?? []), instance] },
          got,
          { completed: c.when.thenCompleted },
        );
      }
      if ("next" in c.expect) return { pass: exact(got, c.expect.next), got };
      return { pass: subset(c.expect, got ?? {}), got };
    }
    case "import":
    case "roundtrip": {
      const got = c.op === "import" ? adapter.import(env, caps) : adapter.roundtrip(env, caps);
      const checks = [];
      if (c.expect.fidelity !== undefined) checks.push(got.fidelity === c.expect.fidelity);
      if (c.expect.reports !== undefined) {
        checks.push(c.expect.reports.every((r) => (got.reports ?? []).some((x) => x === r || x.startsWith(`${r}:`))));
      }
      // A warning nobody can act on is how people learn to ignore warnings.
      if (got.fidelity === "reduced") checks.push((got.reports ?? []).length > 0);
      if (c.expect.result !== undefined) checks.push(subset(c.expect.result, slice(given, got.result, c.of)));
      return { pass: checks.every(Boolean), got };
    }
    default:
      return { pass: false, got: `unknown op "${c.op}"` };
  }
}

export function runSuites(adapter, dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const results = [];
  for (const file of files) {
    const suite = JSON.parse(readFileSync(join(dir, file), "utf8"));
    const byId = new Map(suite.cases.map((c) => [c.id, c]));
    for (const c of suite.cases) {
      let outcome;
      try {
        outcome = runCase(adapter, c, byId);
      } catch (err) {
        outcome = { pass: false, got: `threw: ${err.message}` };
      }
      results.push({ suite: suite.suite, level: c.level ?? suite.level, ...c, ...outcome });
    }
  }
  return results;
}

/**
 * What an implementation has earned, per rung.
 *
 * Derived from the run, never from what anyone claimed. A manifest a producer
 * writes is a promise; one that comes out of a suite is evidence.
 */
export function levelsFrom(results) {
  const byLevel = new Map();
  for (const r of results) {
    const at = byLevel.get(r.level) ?? { passed: 0, failed: 0 };
    at[r.pass ? "passed" : "failed"] += 1;
    byLevel.set(r.level, at);
  }
  let earned = 0;
  for (const level of [...byLevel.keys()].sort((a, b) => a - b)) {
    if (byLevel.get(level).failed > 0) break;
    earned = level;
  }
  return { earned, byLevel: Object.fromEntries([...byLevel].sort((a, b) => a[0] - b[0])) };
}
