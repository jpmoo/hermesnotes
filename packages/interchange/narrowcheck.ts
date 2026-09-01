/**
 * Does narrowing keep its promises?
 *
 * The two narrowings are the first thing in this format that can make an
 * envelope *worse* — every other operation adds. So this runs a real library
 * through both and holds the answers against the rules that let a client trust
 * a subset: it validates, every object can still be read, and nothing that was
 * asked for went missing.
 */
import { narrow } from "./src/narrow.js";
import { validateEnvelope } from "./src/validate.js";
import { toInterchange } from "./src/map.js";
import { loadLibrary } from "./source.js";

const lib = await loadLibrary();
console.log(`read ${lib.from}\n`);
const { envelope } = toInterchange({
  types: lib.types, blocks: lib.blocks, memberships: lib.memberships, seriesRows: lib.seriesRows,
  producer: { name: "hermes", version: "2.0.0" },
});

let bad = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `   ${detail}` : ""}`);
  if (!ok) bad += 1;
};
const objs = (e: Record<string, unknown>) => (e.objects ?? []) as { id: string; type?: string }[];
const readable = (e: Record<string, unknown>) => {
  const ids = new Set(((e.types ?? []) as { id: string }[]).map((t) => t.id));
  return objs(e).every((o) => !o.type || ids.has(o.type));
};

console.log(`whole library: ${objs(envelope).length} objects`);
check("the unnarrowed envelope is valid", validateEnvelope(envelope).valid);

// ---- ?profile=task -------------------------------------------------------
const tasks = narrow(envelope, null, "task");
const declaring = new Set(
  ((envelope.types ?? []) as { id: string; profiles?: Record<string, unknown> }[])
    .filter((t) => t.profiles?.task).map((t) => t.id),
);
const expected = objs(envelope).filter((o) => o.type && declaring.has(o.type)).length;
console.log(`\n?profile=task: ${objs(tasks).length} objects`);
check("valid", validateEnvelope(tasks).valid, JSON.stringify(validateEnvelope(tasks).errors.slice(0, 2)));
check("every object still readable", readable(tasks));
check("kept exactly the objects whose type declares task", objs(tasks).length === expected);
check("dropped something", objs(tasks).length < objs(envelope).length);

// ---- ?since= -------------------------------------------------------------
const some = objs(envelope).slice(0, 3).map((o) => o.id);
const delta = narrow(envelope, {
  rows: [
    { blockId: some[0]!, op: "update", seq: 1 },
    { blockId: some[1]!, op: "update", seq: 2 },
    { blockId: some[2]!, op: "delete", seq: 3 },
    { blockId: "never-existed", op: "delete", seq: 4 },
  ],
}, undefined);
console.log(`\n?since=: ${objs(delta).length} objects, ${((delta.changes ?? []) as unknown[]).length} changes`);
check("valid", validateEnvelope(delta).valid, JSON.stringify(validateEnvelope(delta).errors.slice(0, 2)));
check("every object still readable", readable(delta));
check("carries the two that changed", objs(delta).length === 2);
check("does not carry the deleted one", !objs(delta).some((o) => o.id === some[2]));
check(
  "reports the deletion anyway",
  ((delta.changes ?? []) as { object: string; op: string }[]).some((c) => c.object === some[2] && c.op === "delete"),
);
check("reports a deletion for an object it never sent", 
  ((delta.changes ?? []) as { object: string }[]).some((c) => c.object === "never-existed"));

// ---- a delta with nothing in it -----------------------------------------
//
// The common case by a wide margin: a follower polls every thirty seconds and
// almost every poll finds nothing. This used to answer with every collection in
// the account, so a quiet library still wrote nine blocks into a mirror twice a
// minute — for six days, in the client that found it.
const quiet = narrow(envelope, { rows: [] }, undefined);
const cols = (e: Record<string, unknown>) => (e.collections ?? []) as unknown[];
console.log(`\nquiet ?since=: ${objs(quiet).length} objects, ${cols(quiet).length} collections`);
check("valid", validateEnvelope(quiet).valid);
check("carries no objects", objs(quiet).length === 0);
check("carries no collections either", cols(quiet).length === 0);
check("says so, rather than being an empty document", Array.isArray(quiet.changes));

// A delta that did carry something still carries every board, which is the case
// the narrowing above deliberately does not optimize: the board a card was
// taken *off* no longer lists it, so filtering by membership would drop the one
// collection the follower most needs.
check(
  "a delta that carries something still carries every board",
  cols(delta).length === cols(envelope).length,
);

// ---- both together -------------------------------------------------------
const both = narrow(envelope, { rows: objs(envelope).map((o, i) => ({ blockId: o.id, op: "update", seq: i })) }, "task");
console.log(`\nboth: ${objs(both).length} objects`);
check("valid", validateEnvelope(both).valid);
check("every object still readable", readable(both));
check("agrees with profile alone when everything changed", objs(both).length === expected);

console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
