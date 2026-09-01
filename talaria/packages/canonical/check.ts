/**
 * Does the seam read a real envelope?
 *
 * The port's whole claim is that Talaria can read a library through the format
 * without knowing whose it is. The way to check that is to hand it an envelope
 * and see whether the answers are the same ones it used to get from Hermes'
 * private routes — so this runs the real export through and counts what came
 * out, rather than asserting against a fixture nobody's data resembles.
 */
import { readFileSync } from "node:fs";
import { kindOf, profilesOf, seriesByObject, toCanonical } from "./src/index.js";
import type { Envelope, InterchangeType, Series } from "./src/index.js";

const env = JSON.parse(readFileSync(process.argv[2] ?? "/tmp/hermes-export.json", "utf8")) as Envelope;
const types = new Map<string, InterchangeType>((env.types ?? []).map((t) => [t.id, t]));
const series = seriesByObject(env.series as Series[] | undefined);

let bad = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `   ${detail}` : ""}`);
  if (!ok) bad += 1;
};

console.log(`${(env.types ?? []).length} types, ${(env.objects ?? []).length} objects\n`);
for (const t of env.types ?? []) {
  const declared = profilesOf(t);
  console.log(`  ${(t.name ?? t.id).padEnd(14)} ${kindOf(t).padEnd(13)} profiles: ${declared.join(", ") || "(none)"}`);
}
console.log();

const all = (env.objects ?? []).map((o) =>
  toCanonical(o, o.type ? types.get(o.type) : undefined, {
    appOrigin: "https://example/app",
    series: series.get(o.id) ?? null,
  }),
);

const titled = all.filter((c) => c.title && c.title !== "Untitled").length;
check("every object got a title", titled === all.length, `${titled}/${all.length}`);

const tasks = all.filter((c) => c.kind === "task");
check("tasks were recognized", tasks.length > 0, `${tasks.length}`);
check(
  "every task can be completed",
  tasks.every((c) => c.completable),
  `${tasks.filter((c) => c.completable).length}/${tasks.length}`,
);
check(
  "completion was read through the profile",
  tasks.every((c) => c.completion !== null),
  `${tasks.filter((c) => c.completion).length}/${tasks.length} carry a status`,
);
const done = tasks.filter((c) => c.completion?.done).length;
check("some are done and some are not", done > 0 && done < tasks.length, `${done} done`);

const scheduled = all.filter((c) => c.schedule);
check("dates were found", scheduled.length > 0, `${scheduled.length} scheduled`);
const labeled = scheduled.filter((c) => c.schedule?.startLabel || c.schedule?.endLabel);
check("the producer's own date labels came through", labeled.length > 0, `${labeled.length} labeled`);

const notes = all.filter((c) => c.kind === "note");
check("notes were recognized", notes.length > 0, `${notes.length}`);
check(
  "notes have a body",
  notes.filter((c) => c.body).length > 0,
  `${notes.filter((c) => c.body).length}/${notes.length}`,
);

check("links were derived", all.some((c) => c.links.length > 0), `${all.reduce((n, c) => n + c.links.length, 0)} links`);
check("versions traveled", all.every((c) => typeof c.version === "number"));

// The one thing nothing may do. Comments stripped first: the modules explain
// what they used to read, and a check that cannot tell prose from code would
// have to be satisfied by deleting the explanation.
const code = ["map.ts", "kind.ts", "interchange.ts", "recurrence.ts"]
  .map((f) => readFileSync(new URL(`./src/${f}`, import.meta.url), "utf8"))
  .join("\n")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");
for (const word of ["status_field", "complete_values", "propertySchema", "blockTypeId", "@hermes/"]) {
  check(`the seam never reads ${word}`, !code.includes(word));
}

console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
