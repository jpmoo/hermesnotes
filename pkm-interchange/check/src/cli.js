#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { adapter as reference } from "./reference.js";
import { levelsFrom, runSuites } from "./runner.js";
import { validate } from "./validate.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "..", "..", "fixtures");

const ESC = "[";
const on = process.stdout.isTTY;
const red = (s) => (on ? `${ESC}31m${s}${ESC}0m` : s);
const green = (s) => (on ? `${ESC}32m${s}${ESC}0m` : s);
const dim = (s) => (on ? `${ESC}2m${s}${ESC}0m` : s);

const args = process.argv.slice(2);

if (args.length === 0 || args.includes("--help")) {
  console.log(
    [
      "pkm-check",
      "",
      "  pkm-check <export.json>   validate one export",
      "  pkm-check --self          run the fixtures against the reference adapter",
      "",
      "An implementation plugs in by exporting the eight operations in",
      "fixtures/README.md and calling runSuites() from src/runner.js.",
    ].join("\n"),
  );
  process.exit(0);
}

if (args.includes("--self")) {
  const results = runSuites(reference, FIXTURES);
  let suite = null;
  for (const r of results) {
    if (r.suite !== suite) {
      suite = r.suite;
      console.log(`\n${suite}`);
    }
    const mark = r.na ? dim("n/a ") : r.pass ? green("pass") : red("FAIL");
    console.log(`  ${mark}  ${dim(`L${r.level}`)} ${r.id}`);
    if (!r.pass) {
      console.log(`        expected ${JSON.stringify(r.expect)}`);
      console.log(`        got      ${String(JSON.stringify(r.got)).slice(0, 400)}`);
      console.log(dim(`        why: ${r.why}`));
    }
  }
  const failed = results.filter((r) => !r.pass);
  const { earned, roles, byLevel } = levelsFrom(results);
  console.log(`\n${results.length - failed.length}/${results.length} passing`);
  for (const [level, at] of Object.entries(byLevel)) {
    console.log(
      `  level ${level}: ${at.passed} passed, ${at.failed} failed` + (at.na ? `, ${at.na} not applicable` : ""),
    );
  }
  // Derived from the run, never from what anyone claimed. Per role, because a
  // tool that writes a good file and cannot read one has earned one of those.
  const line = `produce ${roles.produce}  consume ${roles.consume}  operate ${roles.operate}`;
  console.log(failed.length ? red(`\nlevels earned: ${line}`) : green(`\nlevels earned: ${line}`));
  process.exit(failed.length ? 1 : 0);
}

const path = resolve(args[0]);
const { valid, errors } = validate(JSON.parse(readFileSync(path, "utf8")));
if (valid) {
  console.log(green(`${path}: valid`));
} else {
  for (const e of errors) console.log(red(e.code), dim(`at ${e.path}`));
  process.exit(1);
}
