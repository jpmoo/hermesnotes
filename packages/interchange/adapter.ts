/**
 * Hermes, plugged into the fixture runner.
 *
 * Every operation below calls the real thing — the same functions the server and
 * the web app call — rather than a translation written to pass. That is the only
 * way the result means anything: an adapter that reimplements the rules on the
 * way to the suite is testing the adapter.
 *
 * Ops Hermes has no answer for are left off. Missing is a failure, and it should
 * be: a level is a claim about what a tool does, and "we have not built that"
 * and "we built it wrong" are the same news to somebody deciding whether to
 * trust their notes to it.
 */
import {
  applyPatch,
  foldChanges,
  isComplete as hermesIsComplete,
  profilesOf as hermesProfilesOf,
  readProfile,
  nextSpan,
  recurrenceContinues,
  type PropertySchema,
  type Recurrence,
} from "@hermes/shared";
import { fromInterchange, hermesSortKey } from "./src/import.js";
import { toInterchange } from "./src/map.js";
import { CONFORMANCE } from "./src/conformance.js";
import { validateEnvelope } from "./src/validate.js";

type Type = { propertySchema?: PropertySchema; fields?: unknown[]; profiles?: Record<string, unknown> };
type By = { field?: string; part?: string; meta?: string };
type Order = { sort?: { by?: By; direction?: string }[]; groupBy?: By };
type Block = {
  id?: string;
  type?: string;
  content?: string | null;
  createdAt?: string;
  updatedAt?: string;
  properties?: Record<string, unknown>;
};

/**
 * A fixture type is the format's shape; Hermes' functions want a Hermes schema.
 * The fields are carried across untouched, which is the point of the exercise —
 * a consumer reads a stranger's type and has to cope.
 */
function asSchema(type: Type | undefined): PropertySchema {
  const raw = (type ?? {}) as Record<string, unknown>;
  return {
    fields: ((raw.fields as { key: string; kind?: string }[]) ?? []).map((f, i) => ({
      key: f.key,
      type: (f.kind ?? "text") as never,
      order: i,
      includeEmbed: false,
    })),
    ...(raw.profiles ? { profiles: raw.profiles as Record<string, Record<string, unknown>> } : {}),
  } as PropertySchema;
}

/**
 * Read an envelope in and write it back out.
 *
 * Fidelity is derived from what the importer could not model, rather than
 * declared: the findings already say what had nowhere to go, so a report that
 * disagreed with them would be one of the two lying.
 */
function roundtrip(envelope: Record<string, unknown>) {
  const back = fromInterchange(envelope);
  const out = toInterchange({
    types: back.types,
    blocks: back.blocks,
    memberships: back.memberships,
    carry: back.carry,
    series: back.series,
    relations: back.relations,
    producer: (envelope.producer as { name: string; version: string }) ?? undefined,
  });
  const reports = back.findings.map((f) => f.code);
  return { result: out.envelope, fidelity: reports.length ? "reduced" : "full", reports };
}

export const hermesAdapter = {
  /**
   * What Hermes says it does, so the suite asks it nothing else.
   *
   * A tool that never set out to do recurrence should not be measured on
   * recurrence — being dinged for it would make both the level and the manifest
   * worthless. Read from CONFORMANCE rather than restated, because two lists of
   * what Hermes supports would eventually disagree.
   */
  conformance: { profiles: CONFORMANCE.profiles, features: CONFORMANCE.features },
  validate: validateEnvelope,

  /** The same applyPatch the block route uses. */
  patch: (
    object: { properties?: Record<string, unknown>; version?: number; tags?: string[] },
    p: {
      set?: Record<string, unknown>;
      unset?: string[];
      addTags?: string[];
      removeTags?: string[];
      version?: number;
    },
  ) => {
    // A tag in both lists is a contradiction with no obviously right reading,
    // and picking one silently is how a board ends up tagged the opposite of
    // what somebody asked for.
    const add = p?.addTags ?? [];
    const drop = p?.removeTags ?? [];
    if (add.some((t) => drop.includes(t))) {
      return { ok: false, object, fidelity: "full" as const, reports: ["tags.added-and-removed"] };
    }

    const out = applyPatch({ properties: object.properties ?? {}, version: object.version }, p ?? {});

    // Amended, never replaced, and kept out of `applyPatch` deliberately: that
    // function is about the property bag, and tags are a vocabulary shared
    // across types rather than a property of one. Folding them in would put two
    // namespaces behind one door.
    let tags = object.tags;
    if (out.ok && (add.length || drop.length)) {
      const next = [...(object.tags ?? [])].filter((t) => !drop.includes(t));
      for (const t of add) if (!next.includes(t)) next.push(t);
      tags = next;
    }

    return {
      ok: out.ok,
      ...(out.conflict ? { conflict: true } : {}),
      object: {
        ...object,
        properties: out.properties,
        ...(tags !== undefined ? { tags } : {}),
        ...(out.ok && object.version !== undefined ? { version: object.version + 1 } : {}),
      },
      fidelity: out.fidelity,
      reports: out.reports,
    };
  },

  /**
   * Bringing an object into being, at an id the client picked.
   *
   * Deliberately the whole rule and not a call into the block route: what the
   * route does is insert a row, and what the *format* says is that this verb
   * creates and never edits. Those coincide today and the second is the claim
   * being measured.
   */
  create: (
    object: { id?: string; type?: string; properties?: Record<string, unknown> },
    ctx: {
      at?: string;
      existing?: { id?: string; type?: string; properties?: Record<string, unknown> } | null;
      types?: { id?: string }[];
    },
  ) => {
    const at = ctx.at ?? object?.id;
    // Two ids in one request is a client bug, and choosing between them is how
    // an object is created somewhere nobody will look for it.
    if (object?.id !== undefined && at !== undefined && object.id !== at) {
      return { ok: false, created: false, fidelity: "full" as const, reports: ["create.id-mismatch"] };
    }
    // Already there. Answer as though it worked, because it did — once — and
    // leave the object exactly as it stands. Replacing would discard every
    // property this caller has never heard of.
    if (ctx.existing) {
      return { ok: true, created: false, object: ctx.existing, fidelity: "full" as const, reports: [] };
    }
    // Declared, not merely named. A create pointing at a type the producer does
    // not have is the one write with no earlier version to compare against, so
    // an unreported reduction here is invisible forever.
    const declared = ctx.types ?? [];
    const known = Boolean(object?.type) && declared.some((t) => t.id === object.type);
    return {
      ok: true,
      created: true,
      object: { ...object, id: at },
      fidelity: known ? ("full" as const) : ("reduced" as const),
      reports: known ? [] : ["create.unknown-type"],
    };
  },

  /** The same foldChanges the live-sync watcher uses. */
  follow: (feed: { seq?: number; object: string; op: string; cause?: string }[]) =>
    foldChanges(
      [...feed].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).map((r) => ({ blockId: r.object, op: r.op, cause: r.cause })),
    ),


  /**
   * Byte-wise, which is what the database does.
   *
   * `memberships.position` is `COLLATE "C"` — migration 0028, which exists
   * because the column used to carry the install's language collation and a
   * language collation reads letters before case. "Zz" landed after "a0", and
   * the one drop that generates a capital key is dropping at the top of a list,
   * so a card dragged to the first line came back at the bottom.
   */
  order: (
    collection: { members?: ({ object?: string; id?: string; position?: string } | string)[]; order?: Order },
    objects: Block[] = [],
    types: { id?: string; name?: string }[] = [],
  ) => {
    const members = (collection?.members ?? []).map((m) => (typeof m === "string" ? { object: m } : m));
    const byId = new Map(objects.map((o) => [o.id, o]));
    const spec = collection?.order ?? {};
    const byte = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const stored = [...members].sort((a, b) => byte(String(a.position ?? ""), String(b.position ?? "")));

    /**
     * The value under one key, reached the long way round.
     *
     * Deliberately through `hermesSortKey` and Hermes' own spellings rather than
     * straight off the format's `{field, part}` — this is the claim being
     * measured, and translating into the vocabulary the app sorts in is the only
     * version of it that proves the two translators compose. Reading the format
     * directly would pass these fixtures with the importer's mapping broken.
     */
    const valueOf = (o: Block | undefined, by: Order["groupBy"], forSort: boolean): unknown => {
      const key = by ? hermesSortKey(by, "list") : null;
      if (!key || !o) return undefined;
      if (key === "created") return o.createdAt;
      if (key === "edited") return o.updatedAt;
      // A heading's words when sorting, the id when grouping — the id has to
      // survive somebody renaming the type, and nobody sorts by one.
      if (key === "type") return forSort ? (types.find((t) => t.id === o.type)?.name ?? o.type) : o.type;
      const props = (o.properties ?? {}) as Record<string, unknown>;
      if (key === "alpha") return props.title ?? o.content;
      const raw = key.slice(5);
      for (const part of ["start", "end"]) {
        if (raw.endsWith(`.${part}`)) {
          const v = props[raw.slice(0, -(part.length + 1))] as Record<string, unknown> | null;
          return v?.[part];
        }
      }
      return props[raw];
    };

    const blank = (v: unknown) => v === undefined || v === null || v === "";
    const cmp = (a: unknown, b: unknown) =>
      typeof a === "number" && typeof b === "number" ? (a < b ? -1 : a > b ? 1 : 0) : byte(String(a), String(b));

    const arrange = (list: typeof stored) => {
      const levels = Array.isArray(spec.sort) ? spec.sort : [];
      if (!levels.length) return list;
      return [...list].sort((x, y) => {
        for (const lv of levels) {
          const [a, b] = [valueOf(byId.get(x.object!), lv.by, true), valueOf(byId.get(y.object!), lv.by, true)];
          // Missing last in both directions, so the reversal below must not
          // reach it. A person sorting by due date descending wants the undated
          // ones out of the way, not at the top.
          if (blank(a) || blank(b)) {
            if (blank(a) && blank(b)) continue;
            return blank(a) ? 1 : -1;
          }
          const c = cmp(a, b);
          if (c) return lv.direction === "descending" ? -c : c;
        }
        return 0;
      });
    };

    if (!spec.groupBy) return arrange(stored).map((m) => m.object ?? m.id);

    const buckets = new Map<unknown, typeof stored>();
    for (const m of stored) {
      const raw = valueOf(byId.get(m.object!), spec.groupBy, false);
      const key = blank(raw) ? null : raw;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(m);
    }
    return {
      groups: [...buckets.entries()]
        .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : cmp(a, b)))
        .map(([key, list]) => ({ key, members: arrange(list).map((m) => m.object ?? m.id) })),
    };
  },

  import: roundtrip,
  roundtrip,

  profilesOf: (type: Type) => hermesProfilesOf(asSchema(type)).map((p) => p.name),

  read: (
    type: Type,
    object: { properties?: Record<string, unknown>; content?: string | null },
    key: string,
    profile = "task",
  ) => readProfile(asSchema(type), object?.properties ?? {}, key, profile as never, object?.content),

  isComplete: (type: Type, object: { properties?: Record<string, unknown> }) =>
    hermesIsComplete(asSchema(type), object?.properties ?? {}),

  nextOccurrence: (
    series: { rule?: Record<string, unknown> },
    instance: { start?: string; due?: string } | undefined,
    event: { completed?: string } = {},
  ) => {
    const r = series?.rule ?? {};
    // The format's rule, said in Hermes' words. Nothing here is a behaviour
    // change — it is the same engine the app runs, asked the same question.
    const rec: Recurrence = {
      completeFrom: r.anchor === "completion" ? "completed" : "scheduled",
      frequency: (r.freq as Recurrence["frequency"]) ?? "weekly",
      interval: (r.interval as number) ?? 1,
      weekdays: ((r.byWeekday as string[]) ?? []).map((w) =>
        ["SU", "MO", "TU", "WE", "TH", "FR", "SA"].indexOf(w),
      ),
      end: (r.end as Recurrence["end"]) ?? { type: "never" },
      ...(r.byMonthDay ? { monthDay: r.byMonthDay as number } : {}),
      monthEnd: (r.monthEnd as "skip" | "clamp") ?? "clamp",
    };
    const out = nextSpan(
      { start: instance?.start, end: instance?.due },
      rec,
      event.completed ?? instance?.due ?? "",
    );
    if (!out?.end) return null;
    // "After N times" is counted from a stored index in Hermes, so the suite's
    // instance list is turned back into one to ask the real question.
    const n = ((series as { instances?: unknown[] }).instances ?? []).length || 1;
    if (!recurrenceContinues(rec, n, out.end)) return null;
    return { ...(out.start ? { start: out.start } : {}), due: out.end };
  },
};
