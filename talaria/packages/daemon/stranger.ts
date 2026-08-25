/**
 * A producer that is not Hermes.
 *
 * The port's claim is that Talaria reads a library through the format rather
 * than through one app's routes. Nothing that talks only to Hermes can test
 * that: the two were written by the same person in the same week, and agreement
 * proves they agree.
 *
 * So this is a stranger. It is forty lines of fixture with its own vocabulary —
 * a `Chore` whose title lives in `what`, whose due date lives in `by`, and whose
 * finished states are `sorted` and `abandoned` — serving the binding over a real
 * socket. If Talaria can mirror it, complete something in it and move a card
 * around its board, the format did the work.
 *
 *   pnpm --filter @talaria/daemon stranger
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Interchange } from "./src/interchange.js";
import { Mirror } from "./src/mirror.js";
import { Sync } from "./src/sync.js";

// ---- the stranger's library ------------------------------------------------

const TYPES = [
  {
    id: "chore",
    name: "Chore",
    fields: [
      { key: "what", kind: "text" },
      { key: "by", kind: "date", label: "Needed by" },
      { key: "state", kind: "enum", options: ["open", "sorted", "abandoned"] },
      { key: "whose", kind: "reference", targetType: "who", many: true },
      // Nothing here has heard of this. It must survive anyway.
      { key: "faff", kind: "vendor:faff-o-meter" },
    ],
    profiles: {
      task: { title: "what", due: "by", status: "state", completeValues: ["sorted", "abandoned"] },
    },
  },
  {
    id: "scrap",
    name: "Scrap",
    fields: [{ key: "heading", kind: "text" }],
    profiles: { note: { title: "heading", body: "content" } },
  },
  // Declares nothing. A consumer must read its fields and must not guess.
  { id: "who", name: "Who", fields: [{ key: "called", kind: "text" }] },
];

const OBJECTS = [
  {
    id: "c1", type: "chore", version: 3,
    properties: { what: "Bleed the radiators", by: "2026-09-01", state: "open", whose: ["w1"], faff: 7 },
    created: "2026-08-01T09:00:00Z", updated: "2026-08-20T11:00:00Z",
  },
  {
    id: "c2", type: "chore", version: 1,
    properties: { what: "Descale the kettle", by: "2026-08-10", state: "sorted", faff: 2 },
    created: "2026-08-01T09:00:00Z", updated: "2026-08-11T08:00:00Z",
  },
  {
    id: "s1", type: "scrap", version: 1,
    properties: { heading: "" },
    content: "# Radiator notes\n\nThe upstairs one ticks.",
    created: "2026-08-02T09:00:00Z", updated: "2026-08-02T09:00:00Z",
  },
  {
    id: "w1", type: "who", version: 1,
    properties: { called: "The plumber" },
    created: "2026-08-01T09:00:00Z", updated: "2026-08-01T09:00:00Z",
  },
];

/** A smart list: its membership is computed, and it says so. */
const SMART = {
  id: "s2",
  name: "Anything Open",
  kind: "list",
  properties: {},
  membership: { mode: "query", materialized: false, query: { kind: "state", is: "open" } },
  members: [],
};

const BOARD = {
  id: "b1",
  name: "The Wall",
  kind: "matrix",
  properties: { description: "Where chores go" },
  placement: { semantic: true, regions: ["now", { name: "soon", label: "Fairly Soon", color: "#5fa4b5" }, "someday"] },
  membership: { mode: "explicit" },
  // colour is the producer's own key; the format does not name it

  members: [
    { object: "c1", region: "now", position: "a0" },
    { object: "c2", region: "someday", position: "a1" },
  ],
};

// ---- the binding -----------------------------------------------------------

let cursor = 10;
const log: { seq: number; object: string; op: string }[] = [];
const objects = structuredClone(OBJECTS);
const board = structuredClone(BOARD);
/** Everything before this is pruned, so a cursor below it earns a 410. */
let oldest = 0;

const envelope = (only?: Set<string>, changes?: typeof log) => ({
  format: "pkm-interchange/0",
  producer: { name: "stranger", version: "0.1.0" },
  conformance: {
    produce: 4, consume: 0, operate: 4,
    bindings: ["http"], profiles: ["task", "note"], features: ["placement"], unsupported: [],
  },
  cursor: String(cursor),
  types: TYPES,
  objects: only ? objects.filter((o) => only.has(o.id)) : objects,
  collections: [board, SMART],
  ...(changes ? { changes: changes.map((c) => ({ object: c.object, op: c.op })) } : {}),
  findings: [],
});

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const read = async () => JSON.parse(await new Promise<string>((ok) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => ok(b || "{}"));
  }));

  if (url.pathname === "/conformance") return send(200, envelope().conformance);

  if (url.pathname === "/interchange" && req.method === "GET") {
    const since = url.searchParams.get("since");
    const profile = url.searchParams.get("profile");
    if (since !== null) {
      if (Number(since) < oldest) return send(410, { error: "that cursor is older than the log" });
      const rows = log.filter((r) => r.seq > Number(since));
      const gone = new Set(rows.filter((r) => r.op === "delete").map((r) => r.object));
      const touched = new Set(rows.map((r) => r.object).filter((id) => !gone.has(id)));
      return send(200, envelope(touched, rows));
    }
    if (profile) {
      const declaring = new Set(TYPES.filter((t) => (t.profiles as Record<string, unknown>)?.[profile]).map((t) => t.id));
      return send(200, envelope(new Set(objects.filter((o) => declaring.has(o.type)).map((o) => o.id))));
    }
    return send(200, envelope());
  }

  const patch = /^\/interchange\/objects\/(.+)$/.exec(url.pathname);
  if (patch && req.method === "PATCH") {
    void read().then((body) => {
      const o = objects.find((x) => x.id === patch[1]);
      if (!o) return send(404, { ok: false });
      if (body.version !== o.version) return send(409, { ok: false, conflict: true });
      Object.assign(o.properties, body.set ?? {});
      for (const k of body.unset ?? []) delete (o.properties as Record<string, unknown>)[k];
      o.version += 1;
      log.push({ seq: ++cursor, object: o.id, op: "update" });
      send(200, { ok: true, fidelity: "full", reports: [], cursor: String(cursor), object: o });
    });
    return;
  }

  const place = /^\/interchange\/collections\/([^/]+)\/members\/([^/]+)$/.exec(url.pathname);
  if (place && req.method === "PATCH") {
    void read().then((body) => {
      if (body.region !== null && !board.placement.regions.includes(body.region)) {
        return send(400, { ok: false, reports: ["placement.region-not-declared"] });
      }
      const m = board.members.find((x) => x.object === place[2]);
      if (!m) return send(404, { ok: false });
      m.region = body.region;
      log.push({ seq: ++cursor, object: m.object, op: "update" });
      send(200, { ok: true, fidelity: "full", reports: [] });
    });
    return;
  }
  send(404, { error: "no" });
});

// ---- the test --------------------------------------------------------------

const home = mkdtempSync(join(tmpdir(), "stranger-"));
let bad = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `   ${detail}` : ""}`);
  if (!ok) bad += 1;
};

await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const mirror = new Mirror(join(home, "mirror.sqlite"));
const ix = new Interchange(base, () => "no-token-needed");
// `hermes` is only reached for the smart-collection evaluator, and this
// stranger has no smart collections — so nothing here should ever touch it.
const hermes = new Proxy({}, {
  get: () => () => {
    throw new Error("Talaria reached for a Hermes route while talking to a stranger");
  },
}) as never;
const sync = new Sync(ix, hermes, mirror, "https://stranger.example");

const canonical = (id: string) => {
  const raw = mirror.rawBlock(id);
  return raw ? (JSON.parse(raw).canonical as Record<string, unknown>) : null;
};

try {
  console.log(`a stranger on ${base}\n`);

  const said = await ix.conformance();
  check("it says what it can do", said.operate === 4, `operate ${said.operate}, bindings ${said.bindings?.join()}`);

  const first = await sync.baseline();
  check("the library mirrored", first.state === "ok", JSON.stringify(first));
  check("every object arrived", mirror.count() >= 5, `${mirror.count()} rows`);

  const c1 = canonical("c1");
  check("a Chore reads as a task", c1?.kind === "task", String(c1?.kind));
  check("its title came from `what`", c1?.title === "Bleed the radiators", String(c1?.title));
  check(
    "its due date came from `by`, with the producer's label",
    (c1?.schedule as { end?: { value: string }; startLabel?: string })?.end?.value === "2026-09-01",
  );
  check("it is not finished", (c1?.completion as { done: boolean })?.done === false);
  check("it can be finished", c1?.completable === true);
  check(
    "a reference field became a link",
    (c1?.links as { id: string }[]).some((l) => l.id === "w1"),
  );

  const c2 = canonical("c2");
  check("`sorted` counts as done", (c2?.completion as { done: boolean })?.done === true);

  const s1 = canonical("s1");
  check("a Scrap reads as a note", s1?.kind === "note", String(s1?.kind));
  check("its body came from `content`", String(s1?.body ?? "").includes("ticks"));
  check("a titleless note borrowed its first line", s1?.title === "Radiator notes", String(s1?.title));

  const w1 = canonical("w1");
  check("a type declaring nothing is not guessed into a task", w1?.kind !== "task", String(w1?.kind));

  // The board itself, as a thing the app can list. This is the check that was
  // missing when `/boards` went empty: every collection was mirrored correctly
  // and canonicalised with `collectionKind: null`, so nothing downstream could
  // tell a board from a chore.
  const b1 = canonical("b1");
  check("the board is mirrored as an object", b1 !== null);
  check("and still knows it is a board", b1?.collectionKind === "matrix", String(b1?.collectionKind));
  check("with the producer's name for it", b1?.title === "The Wall", String(b1?.title));

  const stored = JSON.parse(mirror.rawBlock("b1")!) as { placement?: { regions?: unknown[] } };
  check("the declared regions travelled", (stored.placement?.regions ?? []).length === 3);
  check(
    "a labelled region kept both halves",
    (stored.placement?.regions?.[1] as { name: string; label: string })?.label === "Fairly Soon",
  );
  check(
    "and a colour the format never named",
    (stored.placement?.regions?.[1] as { color?: string })?.color === "#5fa4b5",
  );

  const smart = JSON.parse(mirror.rawBlock("s2")!) as { membership?: { mode?: string; query?: unknown } };
  check("a computed membership says it is computed", smart.membership?.mode === "query");
  check("and carries the query that computes it", smart.membership?.query !== undefined);

  check("the board is on the wall", mirror.isMember("b1", "c1"));
  check("and it knows which region", mirror.regionOf("b1", "c1") !== null, String(mirror.regionOf("b1", "c1")));

  // ---- writing ------------------------------------------------------------
  const answer = await ix.patch("c1", { set: { state: "sorted" }, version: 3 });
  check("a write lands", answer.ok === true);
  check("and answers with the object", (answer.object as { version: number })?.version === 4);
  check(
    "the field it never mentioned is untouched",
    ((answer.object as { properties: Record<string, unknown> })?.properties?.faff) === 7,
  );

  const stale = await ix.patch("c1", { set: { state: "open" }, version: 3 });
  check("a stale write is refused, not merged", stale.ok === false && stale.conflict === true);

  const moved = await ix.place("b1", "c2", "now");
  check("a card moves to a named region", moved.ok === true);
  const nowhere = await ix.place("b1", "c2", "urgent-important");
  check("a region the board never declared is refused", nowhere.ok === false);

  // ---- catching up --------------------------------------------------------
  const second = await sync.catchUp();
  check("the delta applied", second.state === "ok", JSON.stringify(second));
  check("the completion came back", (canonical("c1")?.completion as { done: boolean })?.done === true);
  check("the move came back", mirror.regionOf("b1", "c2") === 0, `region ${mirror.regionOf("b1", "c2")}`);
  check("the unknown field survived the round trip", JSON.parse(mirror.rawBlock("c1")!).properties.faff === 7);

  // ---- a deletion ---------------------------------------------------------
  const idx = objects.findIndex((o) => o.id === "c2");
  objects.splice(idx, 1);
  board.members = board.members.filter((m) => m.object !== "c2");
  log.push({ seq: ++cursor, object: "c2", op: "delete" });
  await sync.catchUp();
  check("a deletion is applied", mirror.rawBlock("c2") === null);
  check("and it left the board with it", !mirror.isMember("b1", "c2"));

  // ---- a cursor older than the log ----------------------------------------
  oldest = cursor + 1;
  const rescued = await sync.catchUp();
  check("a pruned cursor re-reads everything", rescued.state === "ok" && rescued.walked === true);
  check("and the library is whole again", canonical("c1") !== null);

  // ---- a producer whose claim outruns its answers -------------------------
  //
  // The case no manifest catches on its own. `conformance` is compiled into the
  // software, so a deployment running last week's code claims everything this
  // week's code does — and a consumer that quietly copes will cope for months
  // while somebody wonders why completing a task never sticks.
  const { discrepancies } = await import("./src/interchange.js");
  const overclaim = { produce: 4, consume: 4, operate: 4, bindings: ["http"] };
  const behind = { objects: [{ id: "x" }, { id: "y" }], types: [] };
  const gaps = discrepancies(overclaim, behind);
  check("an overclaiming producer is caught", gaps.length === 3, gaps.map((g) => g.code).join(", "));
  check("no cursor is noticed", gaps.some((g) => g.code === "read.no-cursor"));
  check("no version is noticed", gaps.some((g) => g.code === "read.no-version"));
  check("silence about findings is noticed", gaps.some((g) => g.code === "read.no-reports"));
  check(
    "an honest producer raises nothing",
    discrepancies(overclaim, envelope() as unknown as Record<string, unknown>).length === 0,
  );
  check("what this stranger served is clean", sync.mismatch.length === 0, JSON.stringify(sync.mismatch));

  console.log(bad ? `\n${bad} failed` : "\nall good — Talaria read a stranger");
} finally {
  mirror.close();
  server.close();
  rmSync(home, { recursive: true, force: true });
}
process.exit(bad ? 1 : 0);
