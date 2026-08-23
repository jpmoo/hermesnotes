/**
 * Out through the format and back again, on a real library.
 *
 * Level 2 is the claim that a tool can be a waypoint rather than a terminus, and
 * the only way to demonstrate it is to send data through and diff what comes
 * back. Anything that differs is something Hermes quietly ate.
 */
import { DatabaseSync } from "node:sqlite";
import { fromInterchange, toInterchange } from "./src/index.js";
import type { HermesBlock, HermesMembership, HermesType } from "./src/types.js";

const db = new DatabaseSync(`${process.env.HOME}/Library/Application Support/Talaria/mirror.sqlite`);
const types = (db.prepare("select raw from block_types").all() as { raw: string }[]).map(
  (r) => JSON.parse(r.raw) as HermesType,
);
const blocks = (db.prepare("select raw from blocks").all() as { raw: string }[]).map(
  (r) => JSON.parse(r.raw) as HermesBlock,
);
const memberships = (
  db.prepare("select collection_id, block_id, position, context from memberships").all() as {
    collection_id: string; block_id: string; position: string | null; context: string;
  }[]
).map<HermesMembership>((m) => ({
  collectionId: m.collection_id,
  blockId: m.block_id,
  position: m.position,
  context: JSON.parse(m.context ?? "{}") as Record<string, unknown>,
}));

const first = toInterchange({ types, blocks, memberships, producer: { name: "hermes", version: "2.0.0" } });
const back = fromInterchange(first.envelope);
const second = toInterchange({
  types: back.types,
  blocks: back.blocks,
  memberships: back.memberships,
  producer: { name: "hermes", version: "2.0.0" },
  carry: back.carry,
  series: back.series,
  relations: back.relations,
});

const a = JSON.stringify(first.envelope, null, 1).split("\n");
const b = JSON.stringify(second.envelope, null, 1).split("\n");
let differing = 0;
const shown: string[] = [];
for (let i = 0; i < Math.max(a.length, b.length); i++) {
  if (a[i] === b[i]) continue;
  differing += 1;
  if (shown.length < 12) shown.push(`  line ${i}\n    out  ${a[i] ?? "(end)"}\n    back ${b[i] ?? "(end)"}`);
}
console.log(`out: ${a.length} lines   back: ${b.length} lines   differing: ${differing}`);
if (shown.length) console.log(`\nfirst differences:\n${shown.join("\n")}`);
console.log(`\nimport findings:`);
for (const f of back.findings) console.log(`  [${f.owner}] ${f.code}  x${f.count}\n      ${f.detail}`);
process.exit(differing ? 1 : 0);
