/** Run the interchange fixtures against Hermes itself, and report the level. */
import { levelsFrom, runSuites } from "../../pkm-interchange/check/src/runner.js";
import { hermesAdapter } from "./adapter.js";

const FIXTURES = new URL("../../pkm-interchange/fixtures", import.meta.url).pathname;
const results = runSuites(hermesAdapter as never, FIXTURES);

let suite = "";
for (const r of results as { suite: string; level: number; id: string; pass: boolean; got: unknown }[]) {
  if (r.suite !== suite) {
    suite = r.suite;
    console.log(`\n${suite}`);
  }
  const why = r.pass ? "" : `   ${String(JSON.stringify(r.got)).slice(0, 90)}`;
  console.log(`  ${r.pass ? "pass" : "FAIL"}  L${r.level} ${r.id}${why}`);
}
const { earned, byLevel } = levelsFrom(results);
console.log(`\n${(results as { pass: boolean }[]).filter((r) => r.pass).length}/${results.length} passing`);
for (const [level, at] of Object.entries(byLevel)) {
  console.log(`  level ${level}: ${(at as { passed: number }).passed} passed, ${(at as { failed: number }).failed} failed`);
}
console.log(`\nHermes earns: level ${earned}`);
