import { validate } from "./validate.js";

/**
 * "Am I compliant?" — answered from one file.
 *
 * Validity is not the question people arrive with. `valid` means the document is
 * well-formed, and somebody who has just written their first exporter wants to
 * know where they stand and what to do next. A checker that answers a different
 * question than the one asked sends people away thinking they are finished.
 *
 * So: a rung, and one thing to do to reach the next.
 *
 * Only what a file can honestly show. Producing is visible here — the export is
 * the evidence. Consuming and operating are not: a document cannot demonstrate
 * that a tool preserves what it did not understand, or that a partial write
 * leaves the rest alone. Those are claimed in the manifest and measured by the
 * suite or by `--url`, and this says so rather than scoring what it cannot see.
 */

const V0_PROFILES = ["task", "event", "contact", "note"];

export function assess(envelope) {
  const e = envelope ?? {};
  const checks = [];
  const note = (ok, name, detail) => checks.push({ ok, name, detail });

  const { valid, errors } = validate(e);
  const codes = [...new Set(errors.map((x) => x.code))];
  note(valid, "well-formed", valid ? "no rule broken" : codes.join(", "));

  const types = e.types ?? [];
  const objects = e.objects ?? [];
  const hasBody = types.length > 0 && objects.length > 0;
  note(hasBody, "has something in it", `${types.length} type(s), ${objects.length} object(s)`);

  const declaring = types.filter((t) =>
    Object.keys(t.profiles ?? {}).some((p) => V0_PROFILES.includes(p)),
  );
  note(
    declaring.length > 0,
    "types say what they are",
    declaring.length
      ? `${declaring.length} of ${types.length} declare a profile`
      : "none — a consumer has to guess which field is a due date",
  );

  const reports = e.findings ?? e.reports;
  note(
    Array.isArray(reports),
    "says what it could not express",
    Array.isArray(reports) ? `${reports.length} reported` : "nothing reported",
  );

  // A rung is only claimed when everything beneath it holds.
  let produce = -1;
  if (valid && hasBody) produce = 0;
  if (produce === 0 && declaring.length > 0) produce = 1;
  // Level 2 is round-trip and level 3 is loud failure. Neither is demonstrable
  // by a document: one needs data to go through the tool and come back, the
  // other needs a tool that had something to lose.

  const next =
    produce < 0
      ? valid
        ? "Put something in it. An export needs at least one type and one object to be evidence of anything."
        : `Fix what the validator named: ${codes.join(", ")}. Each code is a rule in AGENTS.md.`
      : produce === 0
        ? "Declare a profile on at least one type — `task`, `event`, `contact` or `note` — mapping your own field names onto it. That is level 1, and it is the rung that makes agents and other apps able to read your data. See \"Level 1\" in the README."
        : "Level 2 is round-trip: data that passes through your app comes back with the fields you never modeled still in it. A file cannot show that. Run the suite in-process, or `pkm-check --url` against your running app.";

  return { checks, produce, next };
}
