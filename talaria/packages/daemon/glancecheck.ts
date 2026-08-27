/**
 * The parts of Glance that fail quietly.
 *
 * Similarity search has no wrong answers, only worse ones — a mismatched model
 * returns a plausible ranking rather than an error, and a stale index returns
 * yesterday's library with a straight face. Neither shows up as a crash, so
 * both are checked here.
 *
 *   pnpm --filter @talaria/daemon glancecheck
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cosine, Glance, isLocal, mayEmbedTitle, type Embedder } from "./src/glance.js";
import { TITLE_BLIND } from "./src/context.js";
import { Mirror } from "./src/mirror.js";

let bad = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `   ${detail}` : ""}`);
  if (!ok) bad += 1;
};

// ---- the arithmetic -------------------------------------------------------

const v = (...n: number[]) => Float32Array.from(n);
check("a vector is nearest itself", cosine(v(1, 2, 3), v(1, 2, 3)) > 0.999);
check("scale does not change direction", Math.abs(cosine(v(1, 2, 3), v(2, 4, 6)) - 1) < 1e-6);
check("orthogonal is zero", Math.abs(cosine(v(1, 0), v(0, 1))) < 1e-6);
check(
  "different lengths score zero rather than throwing",
  cosine(v(1, 2, 3), v(1, 2)) === 0,
  "a 768 and a 1024 must not be compared",
);

// ---- the title policy -----------------------------------------------------

check(
  "a password manager's title is never read, even to embed",
  TITLE_BLIND.length > 0 && !mayEmbedTitle(TITLE_BLIND[0]!, TITLE_BLIND),
  TITLE_BLIND[0],
);
check(
  "an ordinary app's title may be embedded",
  mayEmbedTitle("com.microsoft.Excel", TITLE_BLIND),
  "the record would withhold this one; Glance keeps nothing, so it may look",
);

// ---- the same promise, in both places -------------------------------------
//
// The app holds the accessibility grant, so the app is what reads a window, and
// it therefore carries its own copy of the blind list — a check that ran only
// in the daemon would run after the looking had already happened. Two copies of
// a safety floor is a drift hazard, and the drift is silent in the worst
// direction: a name missing from the Swift copy is a password manager being
// read, with nothing on fire and no test red.
//
// So the two are compared. Parsed out of the Swift source rather than exported
// from somewhere shared, because there is nothing both a Node process and a
// signed AppKit binary can import.
{
  const swift = readFileSync(new URL("../../app/Sources/GlanceView.swift", import.meta.url), "utf8");
  const block = /static let blind: Set<String> = \[([^\]]*)\]/.exec(swift)?.[1] ?? "";
  const inApp = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).sort();
  const inDaemon = [...TITLE_BLIND].sort();
  const missing = inDaemon.filter((id) => !inApp.includes(id));
  const extra = inApp.filter((id) => !inDaemon.includes(id));
  check(
    "the app is blind to everything the daemon is blind to",
    inApp.length > 0 && missing.length === 0,
    missing.length ? `the app would read: ${missing.join(", ")}` : `${inApp.length} apps`,
  );
  check(
    "and to nothing the daemon has not heard of",
    extra.length === 0,
    extra.length ? `only in the app: ${extra.join(", ")}` : "",
  );
}

// ---- what it will and will not start -------------------------------------
//
// Glance starts a *local* model server when it finds one asleep, because Ollama
// on macOS runs only while its app is open and asking somebody to go and open it
// defeats the point of a hotkey. It must never do that for a remote address:
// "start the server" aimed at another machine is useless, and reaching for a
// model that is not on this laptop is the one thing the whole design forbids.
//
// Asserted against the predicate rather than against wall-clock time. Timing was
// the first attempt and it measured the wrong thing entirely: ten seconds
// against an unroutable address is TCP giving up, and would have read as "it
// tried to start something" when nothing of the sort had happened.
check("localhost is local", isLocal("http://localhost:11434"));
check("127.0.0.1 is local", isLocal("http://127.0.0.1:11434"));
check("the LAN is not", !isLocal("http://192.168.0.244:11434"));
check("nor is anywhere else", !isLocal("https://api.example.com"));
check(
  "nor is something merely spelled like it",
  !isLocal("http://localhost.evil.example/"),
  "a prefix match here would start reaching off the machine",
);

// ---- the index ------------------------------------------------------------

const home = mkdtempSync(join(tmpdir(), "glancecheck-"));
const mirror = new Mirror(join(home, "mirror.sqlite"));

/** A model that answers deterministically, so the ranking is checkable. */
const fake = (model: string, dim = 4): Embedder & { calls: number } => ({
  model,
  calls: 0,
  async embed(text: string) {
    (fake as unknown as { last: number }).last = 0;
    const out = new Float32Array(dim);
    for (let i = 0; i < text.length; i++) out[i % dim] += text.charCodeAt(i) / 100;
    return out;
  },
});

try {
  const put = (id: string, title: string) =>
    mirror.putBlocks([
      { id, raw: JSON.stringify({ id }), updatedAt: "now", archived: false,
        title, body: "", kind: "task", typeId: null, noteDate: null },
    ]);
  put("a", "bleed the radiators");
  put("b", "descale the kettle");

  const one = fake("model-one");
  const g = new Glance(mirror, one);
  const first = await g.index(50);
  check("everything with words gets a vector", first.embedded === 2, JSON.stringify(first));

  const again = await g.index(50);
  check("a block nobody edited is not embedded twice", again.embedded === 0, JSON.stringify(again));

  put("a", "bleed the radiators upstairs");
  const third = await g.index(50);
  check("a block whose words changed is embedded again", third.embedded === 1, JSON.stringify(third));

  const hits = await g.similar("bleed the radiators upstairs", 2);
  check("the nearest is the one that says the same thing", hits[0]?.id === "a", JSON.stringify(hits[0]));

  // ---- the failure that returns a plausible number ------------------------
  const other = new Glance(mirror, fake("model-two"));
  const stranded = other.nearest(v(1, 1, 1, 1), 5);
  check(
    "vectors from another model are not silently compared",
    stranded.length === 0,
    `${stranded.length} hit(s) from an index built by a different model`,
  );

  const forgotten = other.reconcileModel();
  check("changing model throws the index away", forgotten === 2, `${forgotten} forgotten`);
  check("and says how many, rather than rebuilding in silence", forgotten > 0);
} finally {
  mirror.close();
  rmSync(home, { recursive: true, force: true });
}

console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
