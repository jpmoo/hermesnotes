/** Run the interchange fixtures against Hermes itself, and report the level. */
import { levelsFrom, runSuites } from "../../pkm-interchange/check/src/runner.js";
import { hermesAdapter } from "./adapter.js";
import { CONFORMANCE } from "./src/conformance.js";

const FIXTURES = new URL("../../pkm-interchange/fixtures", import.meta.url).pathname;
const results = runSuites(hermesAdapter as never, FIXTURES);

let suite = "";
for (const r of results as { suite: string; level: number; id: string; pass: boolean; na?: boolean; got: unknown }[]) {
  if (r.suite !== suite) {
    suite = r.suite;
    console.log(`\n${suite}`);
  }
  const why = r.pass || r.na ? "" : `   ${String(JSON.stringify(r.got)).slice(0, 90)}`;
  console.log(`  ${r.na ? "n/a " : r.pass ? "pass" : "FAIL"}  L${r.level} ${r.id}${why}`);
}
const { earned, roles, byLevel } = levelsFrom(results) as {
  earned: number;
  roles: Record<"produce" | "consume" | "operate", number>;
  byLevel: Record<string, unknown>;
};
console.log(`\n${(results as { pass: boolean }[]).filter((r) => r.pass).length}/${results.length} passing`);
for (const [level, at] of Object.entries(byLevel)) {
  const a = at as { passed: number; failed: number; na: number };
  console.log(`  level ${level}: ${a.passed} passed, ${a.failed} failed` + (a.na ? `, ${a.na} not applicable` : ""));
}
console.log(`\nHermes earns: produce ${roles.produce}  consume ${roles.consume}  operate ${roles.operate}`);

// A claim nobody checks is a claim. Every level in CONFORMANCE has to be one the
// suite just agreed with, or this exits non-zero and the endpoint is lying.
// Each role against the cases that are evidence about that role, rather than
// three numbers checked against one. A tool that writes a good file and cannot
// read one has earned exactly one of those, and should not be able to say
// otherwise.
const over = (["produce", "consume", "operate"] as const).filter((r) => CONFORMANCE[r] > roles[r]);
if (over.length) {
  console.log(
    `\nCONFORMANCE overclaims: ${over.map((r) => `${r} says ${CONFORMANCE[r]}, earned ${roles[r]}`).join("; ")}.`,
  );
  process.exit(1);
}
console.log(
  `CONFORMANCE claims produce ${CONFORMANCE.produce}, consume ${CONFORMANCE.consume}, ` +
    `operate ${CONFORMANCE.operate}; the suite earned ${roles.produce}/${roles.consume}/${roles.operate}.`,
);
