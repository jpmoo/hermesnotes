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
  isComplete as hermesIsComplete,
  profilesOf as hermesProfilesOf,
  readProfile,
  nextSpan,
  recurrenceContinues,
  type PropertySchema,
  type Recurrence,
} from "@hermes/shared";

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

export const hermesAdapter = {
  profilesOf: (type: Type) => hermesProfilesOf(asSchema(type)).map((p) => p.name),

  read: (type: Type, object: { properties?: Record<string, unknown> }, key: string, profile = "task") =>
    readProfile(asSchema(type), object?.properties ?? {}, key, profile as never),

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
