/**
 * A smart collection's members are the query's answer, not its membership rows.
 *
 * Beside `materialized: false` the format defines `members` as a snapshot of
 * what the query returns — a courtesy for consumers that cannot run it, and one
 * they are entitled to read as the truth. The exporter used to ship the
 * membership rows whenever there were any, on the reasoning that a placement is
 * stated fact and a snapshot is only a courtesy. Both halves are true and the
 * conclusion was wrong: the real Eisenhower matrix went out with 37 members
 * under a query that matched 16, so it arrived carrying 21 completed tasks and
 * a pile of things whose dates had fallen out of range.
 *
 * Nothing rendered it wrongly. The export said those objects were what the
 * query returned, and every consumer that believed it was correct to.
 *
 * Its own script for the same reason as `regioncheck`: it is a fact about one
 * function and needs no library.
 */
import { fromInterchange } from "./src/import.js";
import { toInterchange } from "./src/map.js";

let bad = 0;
const check = (n: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${n}${d ? `   ${d}` : ""}`);
  if (!ok) bad += 1;
};

const stamp = { createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
const task = (id: string) => ({
  id, blockTypeId: "t_task", collectionKind: null, content: null,
  properties: { title: id }, archivedAt: null, tags: [], ...stamp,
});

// A board with three cards placed by hand and one match that has not been
// placed yet. The query returns two of the placed cards and the loose one.
const board = {
  id: "c_matrix", blockTypeId: null, collectionKind: "matrix", content: null,
  properties: {
    title: "Eisenhower",
    membership_mode: "smart",
    smart_mode: "dynamic",
    filter_query: { match: "all", conditions: [] },
    matrix_cols: 2, matrix_rows: 1,
    matrix_regions: [{ title: "urgent" }, { title: "calm" }],
  },
  archivedAt: null, tags: [], ...stamp,
};

const { envelope, findings } = toInterchange({
  types: [{ id: "t_task", name: "Task", propertySchema: { fields: [{ key: "title", type: "text" }] } }] as never,
  blocks: [board, task("o_1"), task("o_2"), task("o_done"), task("o_loose")] as never,
  memberships: [
    { collectionId: "c_matrix", blockId: "o_1", position: "a0", context: { region: 0 } },
    { collectionId: "c_matrix", blockId: "o_2", position: "a1", context: { region: 1 } },
    // Placed once, and no longer returned by the query — the completed card.
    { collectionId: "c_matrix", blockId: "o_done", position: "a2", context: { region: 0 } },
  ] as never,
  queryMembers: new Map([["c_matrix", ["o_1", "o_2", "o_loose"]]]),
});

const c = (envelope.collections as Record<string, unknown>[])[0]!;
const members = (c.members ?? []) as { object: string; region?: string }[];
const ids = members.map((m) => m.object).sort();
console.log(`  ${JSON.stringify(members)}\n`);

check("members are the query's answer", JSON.stringify(ids) === '["o_1","o_2","o_loose"]', ids.join(","));
check("a placed object that no longer matches is not a member", !ids.includes("o_done"));
check(
  "a match nobody has placed yet is still a member",
  ids.includes("o_loose"),
  "these are the cards a board offers you to drag in; filtering the rows would have dropped them",
);
check(
  "a member that was placed keeps its region",
  members.find((m) => m.object === "o_1")?.region === "urgent",
);
check(
  "a match nobody placed has no region",
  members.find((m) => m.object === "o_loose")?.region === undefined,
);

const props = (c.properties ?? {}) as Record<string, unknown>;
const kept = (props["hermes:unmatched_placements"] ?? []) as { object: string }[];
check(
  "the placement it no longer qualifies for is kept under the producer's prefix",
  kept.length === 1 && kept[0]!.object === "o_done",
  "a quadrant somebody chose is a decision, and completing a task must not forget it",
);
check(
  "and the export says so",
  findings.some((f) => f.code === "placement.filtered-out-of-its-own-collection"),
);

/**
 * And back again.
 *
 * The placement under the prefix is only worth keeping if something reads it.
 * Import must turn it back into a membership row — otherwise a foreign tool that
 * imported this library and handed it back would return the board with every
 * completed card's quadrant erased, which is the round-trip rule broken on a
 * decision somebody made by hand.
 */
const back = fromInterchange(envelope);
const rows = (back.memberships as { collectionId: string; blockId: string; context: unknown }[])
  .filter((m) => m.collectionId === "c_matrix");
check(
  "importing restores the placement that could not travel as a member",
  rows.some((m) => m.blockId === "o_done" && (m.context as { region?: number })?.region === 0),
  rows.map((m) => m.blockId).join(","),
);
check(
  "and it is not left behind in the properties as well",
  !("unmatched_placements" in ((back.blocks as { id: string; properties: Record<string, unknown> }[])
    .find((b) => b.id === "c_matrix")?.properties ?? {})),
  "a key both consumed and carried comes back out twice, next to a freshly computed one",
);

/**
 * The rarer path to the same untruth: a dynamic query nobody ran.
 *
 * The export caps how many queries it evaluates and swallows one that throws,
 * so `queryMembers` can simply have no entry. The rows go out as they are and
 * are reported as unverified — the alternative, shipping nothing, was tried
 * first and it emptied an imported collection whose members were another tool's
 * perfectly good snapshot that Hermes has no engine to recompute.
 */
const notRun = toInterchange({
  types: [{ id: "t_task", name: "Task", propertySchema: { fields: [{ key: "title", type: "text" }] } }] as never,
  blocks: [board, task("o_1"), task("o_done")] as never,
  memberships: [
    { collectionId: "c_matrix", blockId: "o_1", position: "a0", context: { region: 0 } },
    { collectionId: "c_matrix", blockId: "o_done", position: "a2", context: { region: 0 } },
  ] as never,
  queryMembers: new Map(),
});
const nc = (notRun.envelope.collections as Record<string, unknown>[])[0]!;
check(
  "a query that was never run ships its rows unchanged",
  ((nc.members ?? []) as { object: string }[]).map((m) => m.object).join(",") === "o_1,o_done",
  JSON.stringify(nc.members),
);
check(
  "and says they were not verified",
  notRun.findings.some((f) => f.code === "derivation.query-not-evaluated"),
  "emptying it instead was the first attempt — right for a matrix of placements, and it destroyed the imported snapshot of a stranger's collection Hermes cannot recompute",
);

console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
