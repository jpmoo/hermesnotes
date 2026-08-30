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

const PROFILES = ["task", "event", "contact", "note", "journal"];

/** Features a manifest is expected to declare, and how to spot each in the data. */
const FEATURES: Record<string, (e: Env) => boolean> = {
  series: (e) => (e.series ?? []).length > 0,
  relations: (e) => (e.relations ?? []).length > 0,
  placement: (e) => (e.collections ?? []).some((c) => Boolean(c.placement)),
  derivations: (e) => (e.collections ?? []).some((c) => c.membership?.mode === "query"),
  ordering: (e) => (e.collections ?? []).some((c) => Boolean(c.order?.sort || c.order?.groupBy)),
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
  /// Open, because a producer may hang whatever it likes here and the point of
  /// reading it is to catch a key that should not exist.
  producer?: Record<string, unknown>;
  conformance?: {
    produce?: number;
    consume?: number;
    operate?: number;
    bindings?: string[];
    features?: string[];
  };
  types?: { id?: string; fields?: Field[]; profiles?: Record<string, Record<string, unknown>> }[];
  objects?: { id?: string; type?: string; properties?: Record<string, unknown>; suggests?: string }[];
  collections?: {
    placement?: { semantic?: boolean; regions?: (string | { name?: string; label?: string })[] };
    membership?: { mode?: string };
    members?: unknown[];
    order?: {
      sort?: { by?: { field?: string; part?: string; meta?: string }; direction?: string }[];
      groupBy?: { field?: string; part?: string; meta?: string };
    };
  }[];
  series?: { horizon?: number; rule?: Record<string, unknown> }[];
  relations?: { from?: string; to?: string; via?: string; field?: string }[];
  changes?: { op?: string; cause?: string }[];
}

const META_KEYS = new Set(["type", "created", "updated"]);

export function validateEnvelope(envelope: unknown): { valid: boolean; errors: Invalid[] } {
  const e = (envelope ?? {}) as Env;
  const errors: Invalid[] = [];
  const fail = (code: string, path: string) => errors.push({ code, path });

  if (typeof e.format === "string" && !/^pkm-interchange\/\d+$/.test(e.format)) {
    fail("envelope.format", "format");
  }

  // A profile mapping has to land on a field the type declares. Claiming the
  // task profile and pointing `due` at nothing is the one way to hold level 1
  // while providing none of it, and it is invisible from anywhere else: the
  // envelope is well-formed and the profile name is spelled right.
  //
  // Not every entry in a mapping is a field name. `completeValues` is a list of
  // values, a compound field is named through `{field, part}` and the rule
  // belongs to `field`, and `content` is the reserved body slot rather than a
  // property. Profiles outside the v0 vocabulary are carried uninterpreted, so
  // their mappings are nobody's business here.
  (e.types ?? []).forEach((t, i) => {
    const declared = new Set((t.fields ?? []).map((f) => f.key));
    for (const [profile, map] of Object.entries(t.profiles ?? {})) {
      if (!PROFILES.includes(profile) || map === null || typeof map !== "object") continue;
      for (const [key, spec] of Object.entries(map)) {
        const named =
          typeof spec === "string"
            ? spec
            : spec !== null && typeof spec === "object"
              ? (spec as { field?: unknown }).field
              : undefined;
        if (typeof named !== "string" || named === "content") continue;
        if (!declared.has(named)) {
          fail("profile.field-not-declared", `types[${i}].profiles.${profile}.${key}`);
        }
      }
    }
  });

  // An object's type has to travel with the object. Narrowing a read — by
  // profile, or to what changed since a cursor — answers with a subset, and a
  // subset holding objects whose types were filtered out is unreadable. Guarded
  // on the envelope declaring types at all, so a fragment is not accused.
  {
    const declaredTypes = new Set((e.types ?? []).map((t) => t.id));
    if (declaredTypes.size) {
      (e.objects ?? []).forEach((o, i) => {
        if (o.type && !declaredTypes.has(o.type)) fail("object.type-not-declared", `objects[${i}].type`);
      });
    }
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
    // A sort key naming nothing runs on nothing: it reads as a declaration and
    // delivers an unsorted list, which is invisible in an otherwise well-formed
    // document — the same failure the profile mapping rule exists to catch.
    for (const spec of [
      ...(Array.isArray(c.order?.sort) ? c.order.sort : []),
      ...(c.order?.groupBy ? [{ by: c.order.groupBy, direction: undefined }] : []),
    ]) {
      const by = spec?.by;
      const named =
        by && typeof by === "object" &&
        (typeof by.field === "string" ? by.field !== "" : META_KEYS.has(String(by.meta)));
      if (!named) fail("order.by-invalid", `collections[${i}].order`);
      if (spec.direction !== undefined && spec.direction !== "ascending" && spec.direction !== "descending") {
        fail("order.direction-invalid", `collections[${i}].order`);
      }
    }

    // A collection answered on its own has to carry what it names.
    //
    // The same failure as a narrowed read that forgot its types, one level up.
    // A consumer asks for a collection's current membership *because* it cannot
    // run the query, so a list of ids it has nothing to resolve against is an
    // answer that is both current and unusable.
    //
    // Only when the objects are there to be checked against: a whole-library
    // read carries everything, and a `since` delta legitimately mentions a
    // member it did not need to resend.
    if ((e.objects ?? []).length) {
      const have = new Set((e.objects ?? []).map((o) => o.id));
      const listed = ((c.members ?? []) as (string | { object?: string })[]).map((m) =>
        typeof m === "string" ? m : m?.object,
      );
      if (listed.length && listed.every((id) => id !== undefined) && !listed.every((id) => have.has(id!))) {
        fail("collection.member-not-carried", `collections[${i}].members`);
      }
    }

    if (c.placement?.semantic !== true) return;
    const named =
      Array.isArray(c.placement.regions) &&
      c.placement.regions.length > 0 &&
      c.placement.regions.every(
        (r) => typeof r === "string" || typeof (r as { name?: unknown })?.name === "string",
      );
    const positioned = (c.members ?? []).some(
      (m) => m !== null && typeof m === "object" && "context" in m && !("region" in m),
    );
    // A coordinate means nothing outside the grid that produced it.
    if (!named || positioned) fail("placement.coordinates-not-semantic", `collections[${i}].placement`);

    // A member matches on `name`, never on `label`. Matching the display text
    // holds until somebody fixes a typo in the wording, and then every card in
    // that region points at one that no longer exists — which is the whole
    // reason the two are separate fields.
    const declaredNames = new Set(
      (c.placement.regions ?? [])
        .map((r) => (typeof r === "string" ? r : (r as { name?: string })?.name))
        .filter((n): n is string => typeof n === "string"),
    );
    for (const m of (c.members ?? []) as { region?: unknown }[]) {
      if (m && typeof m === "object" && typeof m.region === "string" && !declaredNames.has(m.region)) {
        fail("placement.region-not-declared", `collections[${i}].members`);
      }
    }
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

  // An address is a value, never a rule for making one.
  //
  // `urlTemplate` is the cheaper design and it is the wrong one. A consumer
  // holding one will build addresses for objects that never travelled — objects
  // that may not exist — by parsing and interpolating an id this format
  // promises is opaque. One string per object costs bytes; a template costs the
  // id rule, which everything else leans on.
  const producer = e.producer;
  if (producer && typeof producer === "object") {
    for (const k of Object.keys(producer)) {
      if (/template/i.test(k)) fail("address.template-not-a-value", `producer.${k}`);
    }
  }

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
