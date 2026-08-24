/**
 * Out through the format and back again, on a real library.
 *
 * Level 2 is the claim that a tool can be a waypoint rather than a terminus, and
 * the only way to demonstrate it is to send data through and diff what comes
 * back. Anything that differs is something Hermes quietly ate.
 */
import { fromInterchange, toInterchange } from "./src/index.js";
import { loadLibrary } from "./source.js";

const lib = await loadLibrary();
const producer = { name: "hermes", version: "2.0.0" };
const first = toInterchange({ ...lib, producer });
const back = fromInterchange(first.envelope);
const second = toInterchange({
  types: back.types,
  blocks: back.blocks,
  memberships: back.memberships,
  carry: back.carry,
  series: back.series,
  relations: back.relations,
  producer,
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
console.log(`read ${lib.from}`);
console.log(`out: ${a.length} lines   back: ${b.length} lines   differing: ${differing}`);
if (shown.length) console.log(`\nfirst differences:\n${shown.join("\n")}`);
console.log(`\nimport findings:`);
for (const f of back.findings) console.log(`  [${f.owner}] ${f.code}  ×${f.count}\n      ${f.detail}`);
process.exit(differing ? 1 : 0);
