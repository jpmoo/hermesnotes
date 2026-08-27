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
import { fromInterchange } from "./src/import.js";
import { toInterchange } from "./src/map.js";
import { CONFORMANCE } from "./src/conformance.js";
import { validateEnvelope } from "./src/validate.js";

type Type = { propertySchema?: PropertySchema; fields?: unknown[]; profiles?: Record<string, unknown> };

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
    object: { properties?: Record<string, unknown>; version?: number },
    p: { set?: Record<string, unknown>; unset?: string[]; version?: number },
  ) => {
    const out = applyPatch({ properties: object.properties ?? {}, version: object.version }, p ?? {});
    return {
      ok: out.ok,
      ...(out.conflict ? { conflict: true } : {}),
      object: {
        ...object,
        properties: out.properties,
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
  order: (members: { object?: string; id?: string; position?: string }[]) =>
    [...members]
      .sort((a, b) => (String(a.position) < String(b.position) ? -1 : String(a.position) > String(b.position) ? 1 : 0))
      .map((m) => m.object ?? m.id),

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
