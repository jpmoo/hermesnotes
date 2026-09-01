/**
 * What happens when the window manager is not there.
 *
 * AeroSpace answers application, title and workspace together and is the only
 * thing here that knows workspaces exist. Without it Launch Services still
 * names the frontmost app, so the record degrades rather than stops — but two
 * things did not degrade cleanly, and this is those two.
 *
 * Driven by a fake `aerospace` that can be made to answer or not, because the
 * behavior under test is precisely what happens at the moment it stops. The
 * fake matters more than it looks: it is the seam that made swapping Rift for
 * AeroSpace a rewrite of one function rather than of a test suite, because the
 * suite was written against *a window manager* rather than against Rift.
 *
 *   pnpm --filter @talaria/daemon wmcheck
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextRecord, FrontmostWatcher, WM_RECHECK_MS } from "./src/context.js";
import { Mirror } from "./src/mirror.js";

let bad = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `   ${detail}` : ""}`);
  if (!ok) bad += 1;
};

/**
 * Wait for something to become true, rather than for a number of milliseconds.
 *
 * The watcher polls on a timer and shells out to a script on every tick, so how
 * long it takes to record its first row is a fact about how busy the machine is,
 * not about whether the code works. Sleeping a fixed 250ms and then asserting
 * measured the wrong thing: it passed on an idle laptop and failed against a
 * concurrent Swift build, which is the one moment a test result is least
 * welcome and least informative.
 *
 * The timeout is deliberately far longer than anything that could be called
 * slow. It exists so a genuine hang fails the run rather than hanging CI; it is
 * not a budget, and a passing run under load will still return in milliseconds
 * because the poll returns the moment the condition holds.
 */
async function settles(what: () => boolean, timeoutMs = 5000, everyMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (what()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

const home = mkdtempSync(join(tmpdir(), "wmcheck-"));
const cli = join(home, "aerospace");
/** How many times the fake was actually run. */
const calls = join(home, "calls");

/** Rewrite the fake: either it answers with a workspace, or it fails like an absent binary. */
const setWm = (answering: boolean) => {
  writeFileSync(
    cli,
    answering
      ? // `list-windows --focused --format ...` — one tab-separated line of
        // bundle id, workspace, title. Printed for any argv, because what is
        // under test is the parsing and the degradation, not the flag handling.
        `#!/bin/sh\necho x >> ${calls}\nprintf 'com.googlecode.iterm2\\tfirst\\t-zsh\\n'\n`
      : `#!/bin/sh\necho x >> ${calls}\nexit 127\n`,
  );
  chmodSync(cli, 0o755);
};
const callCount = () => {
  try {
    return readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};

const mirror = new Mirror(join(home, "mirror.sqlite"));
const record = new ContextRecord(mirror, []);
record.start();

try {
  // ---- while it is answering ---------------------------------------------
  setWm(true);
  const watcher = new FrontmostWatcher(record, 50, cli);
  watcher.start();
  // Both halves of the same answer, so they arrive on the same tick — waited for
  // together, then asserted separately so a failure names the value it actually
  // found rather than just "timed out".
  const answered = await settles(
    () => record.workspace === "first" && record.recent(1)[0]?.title === "-zsh",
  );
  check("a workspace is recorded while the window manager answers", record.workspace === "first", String(record.workspace));
  const row = record.recent(1)[0];
  check("and a real window title comes with it", row?.title === "-zsh", String(row?.title));

  // ---- the moment it stops ------------------------------------------------
  setWm(false);
  // Conditional on the workspace having been set in the first place. Polling for
  // null is the one assertion here that a broken run passes for free: if nothing
  // ever recorded "first", `workspace` is already null and the wait returns on
  // its first tick having proved nothing. This is about a transition, so the
  // starting state has to be real.
  const forgotten = answered && (await settles(() => record.workspace === null));
  check(
    "the workspace is forgotten once nothing answers for it",
    forgotten,
    answered ? String(record.workspace) : "never held a workspace to forget",
  );

  // ---- and stays quiet ----------------------------------------------------
  // Still a fixed sleep, and it has to be. Everything above waits for something
  // to happen; this waits to confirm that nothing does, and there is no
  // condition to poll for the absence of an event — the wall-clock span *is* the
  // measurement. Load makes this one more forgiving rather than less: a busy
  // machine fits fewer ticks into the window, so a watcher that had gone on
  // calling would still be caught.
  const before = callCount();
  await new Promise((r) => setTimeout(r, 400));
  const after = callCount();
  check(
    "it stops asking a binary it knows is absent",
    after === before,
    `${after - before} call(s) across ~8 ticks`,
  );
  check("but will ask again eventually", WM_RECHECK_MS > 0 && WM_RECHECK_MS <= 15 * 60 * 1000,
    `${WM_RECHECK_MS / 1000}s`);

  // ---- Launch Services still names what is in front ------------------------
  const front = record.recent(1)[0];
  check("the record keeps going without it", Boolean(front?.app), String(front?.app));

  watcher.stop();
} finally {
  mirror.close();
  rmSync(home, { recursive: true, force: true });
}

console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
