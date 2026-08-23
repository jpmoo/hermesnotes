/**
 * Is this envelope well-formed?
 *
 * Written from the spec rather than ported from the reference implementation, on
 * purpose. A rule that only one person can implement is not a rule, and the way
 * to find out whether the prose says enough is to write it a second time from
 * the prose. Two of the checks below needed the fixtures to settle.
 *
 * Errors are codes, not sentences. A caller deciding what to do about a bad
 * import should not be matching on wording, and wording should stay free to
 * improve.
 */

export interface Invalid {
  code: string;
  path: string;
}

const PROFILES = ["task", "event", "contact", "note"];

/** Features a manifest is expected to declare, and how to spot each in the data. */
const FEATURES: Record<string, (e: Env) => boolean> = {
  series: (e) => (e.series ?? []).length > 0,
  relations: (e) => (e.relations ?? []).length > 0,
  placement: (e) => (e.collections ?? []).some((c) => Boolean(c.placement)),
  derivations: (e) => (e.collections ?? []).some((c) => c.membership?.mode === "query"),
  attachments: (e) =>
    (e.objects ?? []).some((o) =>
      Object.values(o.properties ?? {}).some(
        (v) => v !== null && typeof v === "object" && (v as { kind?: string }).kind === "attachment",
      ),
    ) || (e.types ?? []).some((t) => (t.fields ?? []).some((f) => f.kind === "attachment")),
};

interface Field {
  key: string;
  kind?: string;
  many?: boolean;
}
interface Env {
  format?: unknown;
  conformance?: {
    produce?: number;
    consume?: number;
    operate?: number;
    bindings?: string[];
    features?: string[];
  };
  types?: { id?: string; fields?: Field[] }[];
  objects?: { id?: string; type?: string; properties?: Record<string, unknown>; suggests?: string }[];
  collections?: {
    placement?: { semantic?: boolean; regions?: string[] };
    membership?: { mode?: string };
    members?: unknown[];
  }[];
  series?: { horizon?: number; rule?: Record<string, unknown> }[];
  relations?: { from?: string; to?: string; via?: string; field?: string }[];
  changes?: { op?: string; cause?: string }[];
}

export function validateEnvelope(envelope: unknown): { valid: boolean; errors: Invalid[] } {
  const e = (envelope ?? {}) as Env;
  const errors: Invalid[] = [];
  const fail = (code: string, path: string) => errors.push({ code, path });

  if (typeof e.format === "string" && !/^pkm-interchange\/\d+$/.test(e.format)) {
    fail("envelope.format", "format");
  }

  // Cardinality is a declaration, so it has to bite in both directions.
  const typeById = new Map((e.types ?? []).map((t) => [t.id, t]));
  (e.objects ?? []).forEach((o, i) => {
    for (const f of typeById.get(o.type)?.fields ?? []) {
      const v = (o.properties ?? {})[f.key];
      if (v === undefined || v === null) continue;
      if (Boolean(f.many) !== Array.isArray(v)) fail("value.cardinality", `objects[${i}].${f.key}`);
    }
    if (o.suggests !== undefined && !PROFILES.includes(o.suggests)) {
      fail("stub.suggests-not-a-profile", `objects[${i}].suggests`);
    }
  });

  (e.collections ?? []).forEach((c, i) => {
    if (c.placement?.semantic !== true) return;
    const named = Array.isArray(c.placement.regions) && c.placement.regions.length > 0;
    const positioned = (c.members ?? []).some(
      (m) => m !== null && typeof m === "object" && "context" in m && !("region" in m),
    );
    // A coordinate means nothing outside the grid that produced it.
    if (!named || positioned) fail("placement.coordinates-not-semantic", `collections[${i}].placement`);
  });

  (e.series ?? []).forEach((s, i) => {
    const rule = s.rule ?? {};
    if (rule.anchor === "completion") {
      // Only one future instance of a completion-anchored rule is knowable at all.
      if (s.horizon !== undefined && s.horizon !== 1) fail("series.completion-horizon", `series[${i}].horizon`);
      if (((rule.byWeekday as unknown[]) ?? []).length) {
        fail("series.completion-byweekday", `series[${i}].rule.byWeekday`);
      }
    }
    if (rule.freq === "monthly" || rule.freq === "yearly") {
      if (!rule.monthEnd) fail("series.month-end-required", `series[${i}].rule.monthEnd`);
      if (!rule.byMonthDay) fail("series.month-day-required", `series[${i}].rule.byMonthDay`);
    }
  });

  (e.relations ?? []).forEach((r, i) => {
    if (!r.to) fail("relation.no-target", `relations[${i}]`);
    if (r.via !== "inline" || !r.field) return;
    const from = (e.objects ?? []).find((o) => o.id === r.from);
    const type = typeById.get(from?.type);
    // Nothing to check against is not the same as failing a check.
    if (!type) return;
    if (!(type.fields ?? []).some((f) => f.key === r.field)) {
      fail("inline.field-not-declared", `relations[${i}].field`);
    }
  });

  // Only an object can be deleted. A membership or a tag going away is an update
  // to the object that had it, and `delete` is a word every follower treats as
  // final.
  (e.changes ?? []).forEach((row, i) => {
    if (row.op === "delete" && row.cause && row.cause !== "object") fail("changes.child-op", `changes[${i}]`);
  });

  const m = e.conformance;
  if (m) {
    const roles = ["produce", "consume", "operate"] as const;
    if (Array.isArray(m.bindings) && roles.some((r) => m[r] === undefined)) {
      fail("conformance.missing-roles", "conformance");
    }
    // Operating means something can write to you and follow you, and a file on
    // disk is neither.
    if ((m.operate ?? 0) > 0 && !(m.bindings ?? []).some((b) => b !== "file")) {
      fail("conformance.binding-required", "conformance.bindings");
    }
    if (Array.isArray(m.features)) {
      for (const [name, present] of Object.entries(FEATURES)) {
        if (present(e) && !m.features.includes(name)) {
          fail("conformance.undeclared-feature", `conformance.features:${name}`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
