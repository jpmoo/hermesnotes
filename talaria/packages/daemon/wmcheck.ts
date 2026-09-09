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
import {
  ContextRecord,
  FrontmostWatcher,
  focusWorkspace,
  frontmostFromAerospace,
  WM_RECHECK_MS,
  wmStatus,
  workspaces,
} from "./src/context.js";
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

/**
 * Rewrite the fake, into one of the three states a window manager can be in.
 *
 * `answering` — a real row. `absent` — nothing at that path. `disabled` — there,
 * running, and refusing, which is `aerospace enable off` and is the state this
 * suite did not have. It is the interesting one: the refusal is a *sentence*,
 * and everything downstream reads AeroSpace's output as data.
 */
type Wm = "answering" | "absent" | "disabled";
const setWm = (state: Wm | boolean) => {
  const wm: Wm = state === true ? "answering" : state === false ? "absent" : state;
  const script =
    wm === "answering"
      ? // `list-windows --focused --format ...` — one tab-separated line of
        // bundle id, workspace, title. Printed for any argv, because what is
        // under test is the parsing and the degradation, not the flag handling.
        `#!/bin/sh\necho x >> ${calls}\nprintf 'com.googlecode.iterm2\\tfirst\\t-zsh\\n'\n`
      : wm === "disabled"
        ? // Word for word what AeroSpace says, on stdout and exiting zero —
          // the worst case of the two, and the one that turns a refusal into a
          // workspace named after it if anything treats stdout as output.
          `#!/bin/sh\necho x >> ${calls}\necho "AeroSpace server is disabled and doesn't accept commands. You can use 'aerospace enable on' to enable the server"\nexit 0\n`
        : `#!/bin/sh\necho x >> ${calls}\nexit 127\n`;
  writeFileSync(cli, script);
  chmodSync(cli, 0o755);
};
const callCount = () => {
  try {
    return readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};

/**
 * A fake accessibility reader.
 *
 * The real one is a signed binary in the app bundle whose whole job is to hold
 * a permission this suite must not depend on. What is under test is the
 * *fallback* — that a title still arrives when the window manager does not
 * answer — and that is a question about the watcher, not about AX.
 */
const ax = join(home, "talaria-ax");
type Ax =
  /** A title and no opinion about which app it belongs to — the ordinary case. */
  | "answering"
  /** A title belonging to some *other* application, which must be refused. */
  | "stale"
  /** The accessibility grant was not given. */
  | "denied";
const setAx = (state: Ax) => {
  const body =
    state === "answering"
      ? `{"title":"A page with a name"}`
      : state === "stale"
        ? `{"app":"com.apple.Safari","title":"The app you just left"}`
        : `{"denied":true}`;
  writeFileSync(ax, `#!/bin/sh\nprintf '${body}'\n`);
  chmodSync(ax, 0o755);
};
setAx("answering");

const mirror = new Mirror(join(home, "mirror.sqlite"));
/*
 * Titles trusted, which this suite has to say out loud.
 *
 * `TITLE_TRUSTED` is a curated list of bundle ids, and a title from anything
 * else is dropped before it is stored — the right default and the reason an
 * earlier version of the accessibility cases failed while the code under test
 * was working perfectly. What is frontmost on the machine running this suite is
 * not something the suite can choose, so the filter is turned off here and
 * tested where it belongs, in `contextcheck`.
 */
const record = new ContextRecord(mirror, [], true);
record.start();

try {
  // ---- while it is answering ---------------------------------------------
  setWm(true);
  const watcher = new FrontmostWatcher(record, 50, cli, ax);
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

  /*
   * ---- The title outlives the window manager --------------------------------
   *
   * A window title is not AeroSpace's to give — it is an accessibility
   * attribute, and the helper has been reading it for Glance all along. Before
   * this, losing the window manager lost the title with it and the record fell
   * back to an application name, because nothing else was ever asked.
   */
  setWm(false);
  await settles(() => {
    const row = record.recent(1)[0];
    return Boolean(row && row.title === "A page with a name");
  });
  const viaAx = record.recent(1)[0];
  check("a title survives the window manager going away", viaAx?.title === "A page with a name", String(viaAx?.title));
  check("and it is still filed under the real frontmost app", Boolean(viaAx?.app), String(viaAx?.app));

  // A refused grant is not a title. It must not read as one, and must not stop
  // the record: the application name is still worth having.
  setAx("denied");
  await settles(() => {
    const row = record.recent(1)[0];
    return Boolean(row && row.title !== "A page with a name");
  });
  const denied = record.recent(1)[0];
  check("a refused accessibility grant is not recorded as a title",
    denied?.title !== "A page with a name", String(denied?.title));
  check("and the application is still recorded", Boolean(denied?.app), String(denied?.app));

  /*
   * A title read a moment after the frontmost application can belong to the app
   * you just left. Filed under the app you just entered, it is worse than no
   * title: it is a confident wrong answer in the one field a person reads.
   */
  setAx("stale");
  await settles(() => {
    const row = record.recent(1)[0];
    return Boolean(row && row.title !== "A page with a name");
  });
  const stale = record.recent(1)[0];
  check(
    "a title from a different application is refused",
    stale?.title !== "The app you just left",
    String(stale?.title),
  );
  setAx("answering");

  /*
   * ---- Running, and switched off -------------------------------------------
   *
   * `aerospace enable off` does not merely stop tiling: the server refuses every
   * query, and says so in a sentence on a stream that is otherwise output. So a
   * refusal must never reach anything that reads AeroSpace's answer as a value —
   * or the desk grows a workspace called "AeroSpace server is disabled…", the
   * picker offers it, and context rows get stamped with it.
   */
  setWm("disabled");
  const refused = await wmStatus(cli);
  check("a disabled server is told from an absent one", refused === "disabled", refused);

  const listed = await workspaces(cli);
  check("and never becomes a workspace", listed.length === 0, `${listed.length} listed`);

  const seen = await frontmostFromAerospace(cli);
  check("and names no frontmost window", seen === undefined, JSON.stringify(seen));

  const went = await focusWorkspace("first", cli);
  check("and does not claim a move it refused", went === false, String(went));

  setWm("absent");
  check("while a missing binary still reads as absent", (await wmStatus(cli)) === "absent");

  watcher.stop();
} finally {
  mirror.close();
  rmSync(home, { recursive: true, force: true });
}

console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
