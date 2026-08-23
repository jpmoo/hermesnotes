/**
 * Structural validation, reported as codes.
 *
 * Codes rather than prose because a fixture has to be able to assert *which*
 * rule fired without matching an error message, and because a message is
 * something you want to be free to reword.
 *
 * Fragments are accepted. Most fixtures hand over one collection or one rule,
 * and refusing to look at anything short of a whole library would mean the rules
 * could only be tested through a wrapper nobody writes.
 */

/** Features the manifest is expected to declare, and how to spot each in the data. */
const FEATURES = {
  series: (e) => (e.series ?? []).length > 0,
  relations: (e) => (e.relations ?? []).length > 0,
  placement: (e) => (e.collections ?? []).some((c) => c.placement),
  derivations: (e) => (e.collections ?? []).some((c) => c.membership?.mode === "query"),
  attachments: (e) =>
    (e.objects ?? []).some((o) =>
      Object.values(o.properties ?? {}).some((v) => v && typeof v === "object" && v.kind === "attachment"),
    ) || (e.types ?? []).some((t) => (t.fields ?? []).some((f) => f.kind === "attachment")),
};

export function validate(envelope) {
  const errors = [];
  const fail = (code, path) => errors.push({ code, path });

  if (typeof envelope.format === "string" && !/^pkm-interchange\/\d+$/.test(envelope.format)) {
    fail("envelope.format", "format");
  }

  (envelope.collections ?? []).forEach((c, i) => {
    const at = `collections[${i}]`;
    if (c.placement?.semantic === true) {
      const named = Array.isArray(c.placement.regions) && c.placement.regions.length > 0;
      const positioned = (c.members ?? []).some((m) => m && typeof m === "object" && m.context && !m.region);
      // A coordinate means nothing outside the grid that produced it — the same
      // point is a different judgment at another zoom level. A region name opens
      // correctly in a tool that draws no grid at all.
      if (!named || positioned) fail("placement.coordinates-not-semantic", at);
    }
  });

  (envelope.series ?? []).forEach((s, i) => {
    const at = `series[${i}]`;
    const rule = s.rule ?? {};
    if (rule.anchor === "completion") {
      // Completion-anchored recurrence is a state machine waiting on an event
      // that has not happened. More than one instance ahead is not merely
      // unusual, it is unknowable.
      if (s.horizon !== undefined && s.horizon !== 1) fail("series.completion-horizon", `${at}.horizon`);
      if ((rule.byWeekday ?? []).length) fail("series.completion-byweekday", `${at}.rule.byWeekday`);
    }
    if ((rule.freq === "monthly" || rule.freq === "yearly") && !rule.monthEnd) {
      fail("series.month-end-required", `${at}.rule.monthEnd`);
    }
  });

  // An inline edge claims to come from a particular piece of writing. If the
  // field it names does not exist, the claim cannot be traced back to a sentence
  // and a consumer has no way to tell a stale export from a producer guessing.
  const typeById = new Map((envelope.types ?? []).map((t) => [t.id, t]));
  const objectById = new Map((envelope.objects ?? []).map((o) => [o.id, o]));
  (envelope.relations ?? []).forEach((r, i) => {
    if (r.via !== "inline" || !r.field) return;
    const type = typeById.get(objectById.get(r.from)?.type);
    if (!type) return; // nothing to check against; not an error on its own
    if (!(type.fields ?? []).some((f) => f.key === r.field)) {
      fail("inline.field-not-declared", `relations[${i}].field`);
    }
  });

  // Only an object can be deleted. A membership, a tag, a placement going away
  // is an update to the object that had it — and `delete` is a word every
  // follower treats as final.
  (envelope.changes ?? []).forEach((row, i) => {
    if (row.op === "delete" && row.cause && row.cause !== "object") {
      fail("changes.child-op", `changes[${i}]`);
    }
  });

  const manifest = envelope.conformance;
  if (manifest) {
    const roles = ["produce", "consume", "operate"];
    // A level is earned per role: writing a valid file, reading one, and being
    // safe to write to are three different achievements.
    if (Array.isArray(manifest.bindings) && roles.some((r) => manifest[r] === undefined)) {
      fail("conformance.missing-roles", "conformance");
    }
    // Operating means something can write to you and follow you. A file on disk
    // is not something that can be written to and followed.
    const live = (manifest.bindings ?? []).some((b) => b !== "file");
    if ((manifest.operate ?? 0) > 0 && !live) {
      fail("conformance.binding-required", "conformance.bindings");
    }
  }

  // The manifest is a promise about this export, not an aspiration. A feature
  // that turns up in the data without being declared means no part of the
  // manifest can be trusted, which is worse than shipping no manifest.
  const declared = envelope.conformance?.features;
  if (Array.isArray(declared)) {
    for (const [name, present] of Object.entries(FEATURES)) {
      if (present(envelope) && !declared.includes(name)) {
        fail("conformance.undeclared-feature", `conformance.features:${name}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
