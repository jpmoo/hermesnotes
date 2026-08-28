#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { adapter as reference } from "./reference.js";
import { levelsFrom, runSuites } from "./runner.js";
import { assess } from "./assess.js";
import { probe } from "./probe.js";

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
      "  pkm-check <export.json>          validate one export",
      "  pkm-check --url <base> [--token] check a live server, read-only",
      "  pkm-check --self                 the fixtures, against the reference adapter",
      "",
      "--url asks a running instance what it claims, reads what it actually emits,",
      "and holds the two against each other. It writes nothing, so it is safe to",
      "point at anything — including somebody else's server.",
      "",
      "To measure an implementation against the whole suite, export the ten",
      "operations in fixtures/README.md and call runSuites() from src/runner.js.",
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
  // Not applicable is not failure. A case scoped away by the adapter's own
  // `simulates` or `conformance` was never asked, and counting it as a failure
  // meant this command exited non-zero on a clean run — so `npm test` could not
  // pass while a single case was out of scope, which is every run there has
  // ever been.
  const na = results.filter((r) => r.na);
  const failed = results.filter((r) => !r.pass && !r.na);
  const { earned, roles, byLevel } = levelsFrom(results);
  console.log(
    `\n${results.length - failed.length - na.length}/${results.length} passing` +
      (na.length ? `, ${na.length} not applicable` : ""),
  );
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

const urlAt = args.indexOf("--url");
if (urlAt >= 0) {
  const base = args[urlAt + 1];
  const tokenAt = args.indexOf("--token");
  const token = tokenAt >= 0 ? args[tokenAt + 1] : process.env.PKM_TOKEN;
  if (!base) {
    console.log(red("--url needs a base address, e.g. https://host/api"));
    process.exit(2);
  }
  const { checks } = await probe(base, token);
  for (const c of checks) {
    console.log(`  ${c.ok ? green("ok  ") : red("FAIL")}  ${c.name}`);
    console.log(dim(`        ${c.detail}`));
  }
  const bad = checks.filter((c) => !c.ok).length;
  console.log(bad ? red(`\n${bad} problem(s)`) : green("\nnothing to report"));
  process.exit(bad ? 1 : 0);
}

const path = resolve(args[0]);
const { checks, produce, next } = assess(JSON.parse(readFileSync(path, "utf8")));
console.log(`${path}\n`);
for (const c of checks) {
  console.log(`  ${c.ok ? green("ok  ") : red("FAIL")}  ${c.name}`);
  console.log(dim(`        ${c.detail}`));
}
// The rung, then the one thing to do about it. "Valid" answers a question
// nobody asked; people arrive wanting to know where they stand.
const rung = produce < 0 ? red("not yet a valid export") : green(`produce: level ${produce}`);
console.log(`\n  ${rung}`);
console.log(dim("  consume and operate are not visible in a file — see --url or the suite"));
console.log(`\nNext: ${next}`);
process.exit(produce < 0 ? 1 : 0);
