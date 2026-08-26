/**
 * What happens when the window manager is not there.
 *
 * Rift answers application, title and workspace together and is the only thing
 * here that knows workspaces exist. Without it Launch Services still names the
 * frontmost app, so the record degrades rather than stops — but two things did
 * not degrade cleanly, and this is those two.
 *
 * Driven by a fake `rift-cli` that can be made to answer or not, because the
 * behaviour under test is precisely what happens at the moment it stops.
 *
 *   pnpm --filter @talaria/daemon riftcheck
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextRecord, FrontmostWatcher, RIFT_RECHECK_MS } from "./src/context.js";
import { Mirror } from "./src/mirror.js";

let bad = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `   ${detail}` : ""}`);
  if (!ok) bad += 1;
};

const home = mkdtempSync(join(tmpdir(), "riftcheck-"));
const cli = join(home, "rift-cli");
/** How many times the fake was actually run. */
const calls = join(home, "calls");

/** Rewrite the fake: either it answers with a workspace, or it fails like an absent binary. */
const setRift = (answering: boolean) => {
  writeFileSync(
    cli,
    answering
      ? `#!/bin/sh\necho x >> ${calls}\ncat <<'JSON'\n[{"is_active":true,"name":"first","windows":[{"is_focused":true,"bundle_id":"com.googlecode.iterm2","title":"-zsh"}]}]\nJSON\n`
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
  setRift(true);
  const watcher = new FrontmostWatcher(record, 50, cli);
  watcher.start();
  await new Promise((r) => setTimeout(r, 250));
  check("a workspace is recorded while Rift answers", record.workspace === "first", String(record.workspace));
  const row = record.recent(1)[0];
  check("and a real window title comes with it", row?.title === "-zsh", String(row?.title));

  // ---- the moment it stops ------------------------------------------------
  setRift(false);
  await new Promise((r) => setTimeout(r, 250));
  check(
    "the workspace is forgotten once nothing answers for it",
    record.workspace === null,
    String(record.workspace),
  );

  // ---- and stays quiet ----------------------------------------------------
  const before = callCount();
  await new Promise((r) => setTimeout(r, 400));
  const after = callCount();
  check(
    "it stops asking a binary it knows is absent",
    after === before,
    `${after - before} call(s) across ~8 ticks`,
  );
  check("but will ask again eventually", RIFT_RECHECK_MS > 0 && RIFT_RECHECK_MS <= 15 * 60 * 1000,
    `${RIFT_RECHECK_MS / 1000}s`);

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
