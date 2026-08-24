import { validate } from "./validate.js";

/**
 * Check a live server, over the wire, from outside.
 *
 * This is the only way most people can be checked. Running the fixtures against
 * an implementation means writing an adapter and calling the runner in the same
 * process, which works if your app is JavaScript and does not if it is Python,
 * Go, or a thing behind an HTTP boundary. A great many apps are the last one.
 *
 * What can honestly be measured from out here is narrower than the full suite,
 * and saying which is the point. Most fixture operations are pure questions
 * about data the case supplies — "given this type you have never seen, is this
 * object finished" — and there is nowhere to send that. What a server *can* be
 * asked is what it claims, what it actually emits, and whether those two agree.
 *
 * Read-only. Nothing here writes, so it is safe to point at a live instance,
 * including somebody else's.
 */

const FEATURES = {
  series: (e) => (e.series ?? []).length > 0,
  relations: (e) => (e.relations ?? []).length > 0,
  placement: (e) => (e.collections ?? []).some((c) => c.placement),
  derivations: (e) => (e.collections ?? []).some((c) => c.membership?.mode === "query"),
};

async function get(url, token) {
  const res = await fetch(url, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);
  return { status: res.status, body: res.ok ? await res.json() : null };
}

export async function probe(base, token) {
  const root = base.replace(/\/$/, "");
  const out = { checks: [], level: null };
  const note = (ok, name, detail) => out.checks.push({ ok, name, detail });

  // --- what it claims -------------------------------------------------------
  const manifest = await get(`${root}/conformance`, token);
  if (manifest.status !== 200 || !manifest.body) {
    note(false, "conformance", `GET ${root}/conformance answered ${manifest.status}`);
    return out;
  }
  const m = manifest.body;
  note(true, "conformance", `reachable — ${m.format ?? "no format stated"}`);

  const roles = ["produce", "consume", "operate"];
  const missing = roles.filter((r) => m[r] === undefined);
  note(
    missing.length === 0,
    "roles",
    missing.length ? `claims no level for ${missing.join(", ")}` : roles.map((r) => `${r} ${m[r]}`).join(", "),
  );

  const live = (m.bindings ?? []).some((b) => b !== "file");
  note(
    !((m.operate ?? 0) > 0 && !live),
    "bindings",
    (m.bindings ?? []).join(", ") || "none declared",
  );

  // --- what it actually hands over ------------------------------------------
  const exported = await get(`${root}/interchange`, token);
  if (exported.status === 401 && !token) {
    note(true, "export", "needs a token — pass one with --token to check what it emits");
    out.level = "conformance only";
    return out;
  }
  if (exported.status !== 200 || !exported.body) {
    note(false, "export", `GET ${root}/interchange answered ${exported.status}`);
    return out;
  }
  const e = exported.body;
  const { valid, errors } = validate(e);
  note(
    valid,
    "export valid",
    valid ? `${(e.objects ?? []).length} objects, ${(e.types ?? []).length} types` : errors.map((x) => x.code).join(", "),
  );

  // --- do the two agree? ----------------------------------------------------
  // A manifest is a promise about behaviour. This is the one place from outside
  // where the promise and the behaviour can be held against each other.
  const declared = new Set(m.features ?? []);
  const used = Object.entries(FEATURES).filter(([, present]) => present(e)).map(([k]) => k);
  const undeclared = used.filter((f) => !declared.has(f));
  note(
    undeclared.length === 0,
    "manifest matches the data",
    undeclared.length ? `uses ${undeclared.join(", ")} without declaring it` : `${used.length} feature(s), all declared`,
  );

  const unsupported = new Set(m.unsupported ?? []);
  const contradicted = used.filter((f) => unsupported.has(f));
  note(
    contradicted.length === 0,
    "unsupported is honest",
    contradicted.length ? `calls ${contradicted.join(", ")} unsupported and emits it` : "nothing contradicted",
  );

  const typed = (e.types ?? []).filter((t) => Object.keys(t.profiles ?? {}).length).length;
  note(
    typed > 0,
    "types declare what they are",
    typed ? `${typed} of ${(e.types ?? []).length} declare a profile` : "no type declares a profile — a consumer must guess",
  );

  const reports = e.findings ?? e.reports;
  note(
    Array.isArray(reports),
    "says what it could not express",
    Array.isArray(reports)
      ? `${reports.length} finding(s) reported`
      : "no findings reported — an export that reports nothing is claiming to have lost nothing",
  );

  out.level = m;
  return out;
}
