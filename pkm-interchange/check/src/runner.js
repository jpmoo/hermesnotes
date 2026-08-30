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
  if (given.changes) e.changes = [...(e.changes ?? []), ...given.changes];
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
  // A member is an object; a bare id is shorthand for one with nothing else to
  // say. Expanding it is the single normalisation the format permits, so a
  // fixture written either way matches an implementation that chose the other.
  // Encoded here rather than in each expectation, because it is a fact about the
  // format and not about any one case.
  if (typeof expected === "string" && actual && typeof actual === "object" && actual.object === expected) {
    return true;
  }
  if (typeof actual === "string" && expected && typeof expected === "object" && expected.object === actual) {
    return true;
  }
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
      const got = adapter.read(typeOf(obj), obj, c.args.key, c.args.profile ?? "task");
      // `expect: null` in a fixture means "no value" — JSON has no undefined.
      return { pass: exact(got ?? null, c.expect ?? null), got };
    }
    case "isComplete": {
      const obj = (env.objects ?? [])[0];
      const got = adapter.isComplete(typeOf(obj), obj);
      return { pass: got === c.expect, got };
    }
    case "order": {
      // The whole collection, not just its members: the arrangement is stated on
      // the collection and read off the objects, so an adapter handed a bare
      // member list can only ever answer the stored order.
      const got = adapter.order((env.collections ?? [])[0] ?? {}, env.objects ?? [], env.types ?? []);
      return { pass: exact(got, c.expect), got };
    }
    case "journal": {
      const got = adapter.journalFor(env.types ?? [], env.objects ?? [], c.args.date);
      return { pass: exact(got ?? null, c.expect ?? null), got };
    }
    case "outline": {
      const got = adapter.outline(env.objects ?? []);
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
    case "patch": {
      const got = adapter.patch(given.object, given.patch, caps);
      const checks = [got.ok === c.expect.ok];
      if (c.expect.conflict !== undefined) checks.push(Boolean(got.conflict) === c.expect.conflict);
      if (c.expect.fidelity !== undefined) checks.push(got.fidelity === c.expect.fidelity);
      if (c.expect.reports !== undefined) {
        checks.push(
          c.expect.reports.length === 0
            ? (got.reports ?? []).length === 0
            : c.expect.reports.every((r) => (got.reports ?? []).includes(r)),
        );
      }
      if (c.expect.object !== undefined) {
        checks.push(subset(c.expect.object, got.object));
        // A patch that leaves a property behind is the failure this suite is
        // about, so an expected property bag is matched exactly, not loosely.
        if (c.expect.object.properties) {
          checks.push(exact(Object.keys(c.expect.object.properties).sort(),
                            Object.keys(got.object?.properties ?? {}).sort()));
        }
        // Exact, for the same reason, and it matters more here. `subset` on an
        // array asks only that each expected element is present *somewhere*, so
        // a removal that silently did nothing would still pass — which is the
        // failure the remove cases exist to catch. Sorted, because a tag list
        // is a set and the order it returns in is not the subject.
        if (c.expect.object.tags) {
          checks.push(exact([...c.expect.object.tags].sort(), [...(got.object?.tags ?? [])].sort()));
        }
      }
      return { pass: checks.every(Boolean), got };
    }
    /**
     * Bringing an object into being.
     *
     * `given.existing` is the object already at that id, when the case is about
     * a repeat; absent means the id is free. `given.args.at` overrides the
     * address, which is only used by the case where the two ids disagree.
     */
    case "create": {
      const at = given.args?.at ?? given.object?.id;
      const got = adapter.create(
        given.object,
        // The declared types travel with the request, because "is this type
        // real" is a question about the document and not about the object.
        { at, existing: given.existing ?? null, types: env.types ?? [] },
        caps,
      );
      const checks = [];
      if (c.expect.ok !== undefined) checks.push(got.ok === c.expect.ok);
      if (c.expect.created !== undefined) checks.push(Boolean(got.created) === c.expect.created);
      if (c.expect.fidelity !== undefined) checks.push(got.fidelity === c.expect.fidelity);
      if (c.expect.reports !== undefined) {
        checks.push(
          c.expect.reports.length === 0
            ? (got.reports ?? []).length === 0
            : c.expect.reports.every((r) => (got.reports ?? []).includes(r)),
        );
      }
      if (c.expect.object !== undefined) {
        checks.push(subset(c.expect.object, got.object));
        // Exact, for the same reason `patch` is exact: the failure this suite
        // exists to catch is a property quietly not surviving, and a subset
        // match cannot see one that went missing.
        if (c.expect.object.properties) {
          checks.push(exact(Object.keys(c.expect.object.properties).sort(),
                            Object.keys(got.object?.properties ?? {}).sort()));
        }
      }
      return { pass: checks.every(Boolean), got };
    }
    case "follow": {
      const got = adapter.follow(given.feed);
      return {
        pass: exact([...(got.alive ?? [])].sort(), [...c.expect.alive].sort()) &&
              exact([...(got.gone ?? [])].sort(), [...c.expect.gone].sort()),
        got,
      };
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

/**
 * Which role each operation is evidence about.
 *
 * A level is earned per role — writing a valid file, reading one, and being safe
 * to write to are three different achievements, and most tools in this genre can
 * do the first and not the second. The suite has been reporting one number for
 * all three, which is the promise-rather-than-evidence failure it exists to
 * catch, sitting in its own scoreboard.
 *
 * `validate` counts for both producing and consuming: telling a valid export
 * from an invalid one is how you avoid emitting the second and how you notice
 * receiving it. `roundtrip` likewise — it reads and then writes, and the writing
 * half is exactly what producing is.
 *
 * A case may name its own `roles` when the default is wrong for it.
 */
const ROLES = {
  validate: ["produce", "consume"],
  profilesOf: ["consume"],
  read: ["consume"],
  isComplete: ["consume"],
  order: ["consume"],
  nextOccurrence: ["consume"],
  import: ["consume"],
  roundtrip: ["produce", "consume"],
  patch: ["operate"],
  follow: ["operate"],
};

/**
 * Whether a case can be asked of this implementation at all.
 *
 * Most of the interop cases work by simulating a consumer that lacks something —
 * no board, no query engine, no prose. A reference implementation can pretend;
 * a real one cannot. Hermes has a matrix view, and asking it to behave as if it
 * had none tests nothing about Hermes.
 *
 * The line is not "this case has capabilities" — most of those are flavour, and
 * an implementation that genuinely preserves unknown properties should be
 * credited for it whether or not it has the fixed schema the case describes. The
 * line is whether the **expected answer depends** on the lack: a case that
 * requires reduced fidelity because the consumer has no board is asking a
 * question a tool with a board cannot answer. Those cases carry `simulated`.
 *
 * An adapter that can stand in for other tools says `simulates: ["*"]`.
 * Everything skipped is counted next to the level, because an applicability rule
 * is also the obvious way to dodge a suite and the count is what stops that
 * being quiet.
 */
function applicable(adapter, c) {
  // A feature nobody claimed is not a feature anybody failed. A kanban that
  // declares `placement` and not `series` should be measured on boards and asked
  // nothing at all about recurrence — being dinged for a thing it never set out
  // to do would make the level meaningless and the manifest pointless.
  //
  // This is what `conformance.profiles` and `conformance.features` are *for*.
  // Declaring narrowly is the mechanism working.
  //
  // It does not extend to the rules of the road. Round-trip, valid envelopes,
  // partial writes that do not destroy — those are obligations of the level, not
  // features to opt into, and nothing scopes them away.
  const need = c.requires;
  if (need) {
    const has = adapter.conformance ?? {};
    const missing =
      (need.features ?? []).some((f) => !(has.features ?? []).includes(f)) ||
      (need.profiles ?? []).some((p) => !(has.profiles ?? []).includes(p));
    if (missing) return false;
  }
  if (!c.simulated) return true;
  return (adapter.simulates ?? []).includes("*");
}

export function runSuites(adapter, dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const results = [];
  for (const file of files) {
    const suite = JSON.parse(readFileSync(join(dir, file), "utf8"));
    // A suite may scope itself; a case may scope itself more narrowly still.
    const byId = new Map(suite.cases.map((c) => [c.id, c]));
    for (const c of suite.cases) {
      if (!applicable(adapter, { ...c, requires: c.requires ?? suite.requires })) {
          results.push({
          suite: suite.suite,
          level: c.level ?? suite.level,
          roles: c.roles ?? ROLES[c.op] ?? [],
          requires: c.requires ?? suite.requires,
          ...c,
          na: true,
          pass: false,
        });
        continue;
      }
      let outcome;
      try {
        outcome = runCase(adapter, c, byId);
      } catch (err) {
        outcome = { pass: false, got: `threw: ${err.message}` };
      }
      results.push({
        suite: suite.suite,
        level: c.level ?? suite.level,
        roles: c.roles ?? ROLES[c.op] ?? [],
        requires: c.requires ?? suite.requires,
        ...c,
        ...outcome,
      });
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
    const at = byLevel.get(r.level) ?? { passed: 0, failed: 0, na: 0 };
    if (r.na) at.na += 1;
    else at[r.pass ? "passed" : "failed"] += 1;
    byLevel.set(r.level, at);
  }

  /** The highest rung with nothing failing beneath it, over a subset of cases. */
  const climb = (subset) => {
    const levels = new Map();
    for (const r of subset) {
      if (r.na) continue;
      const at = levels.get(r.level) ?? { failed: 0 };
      if (!r.pass) at.failed += 1;
      levels.set(r.level, at);
    }
    let earned = 0;
    for (const level of [...levels.keys()].sort((a, b) => a - b)) {
      if (levels.get(level).failed > 0) break;
      earned = level;
    }
    return earned;
  };

  const roles = {};
  for (const role of ["produce", "consume", "operate"]) {
    roles[role] = climb(results.filter((r) => (r.roles ?? []).includes(role)));
  }
  return {
    earned: climb(results),
    roles,
    byLevel: Object.fromEntries([...byLevel].sort((a, b) => a[0] - b[0])),
  };
}
