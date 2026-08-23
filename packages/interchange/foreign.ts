/** A stranger's library, in and back out. */
import { readFileSync } from "node:fs";
import { fromInterchange, toInterchange } from "./src/index.js";

const envelope = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Record<string, unknown>;
const back = fromInterchange(envelope);
const out = toInterchange({
  types: back.types, blocks: back.blocks, memberships: back.memberships,
  carry: back.carry, series: back.series, relations: back.relations,
  producer: envelope.producer as { name: string; version: string },
});

/** Every leaf of the original, and whether it survived. */
function leaves(v: unknown, path = ""): [string, unknown][] {
  if (v === null || typeof v !== "object") return [[path, v]];
  if (Array.isArray(v)) return v.flatMap((x, i) => leaves(x, `${path}[${i}]`));
  return Object.entries(v).flatMap(([k, x]) => leaves(x, path ? `${path}.${k}` : k));
}
const after = new Map(leaves(out.envelope));
let lost = 0;
const shown: string[] = [];
for (const [path, value] of leaves(envelope)) {
  if (path.startsWith("conformance")) continue; // a claim about the producer, not their data
  // A bare id and a member object mean the same member; the format says so, and
  // expanding the short spelling is the one normalisation it permits.
  if (after.has(`${path}.object`) && after.get(`${path}.object`) === value) continue;
  if (after.has(path) && JSON.stringify(after.get(path)) === JSON.stringify(value)) continue;
  lost += 1;
  if (shown.length < 15) shown.push(`  ${path} = ${JSON.stringify(value)}  ->  ${JSON.stringify(after.get(path))}`);
}
console.log(`${leaves(envelope).length} leaves in, ${lost} did not come back\n`);
if (shown.length) console.log(shown.join("\n"));
console.log(`\nfindings:`);
for (const f of back.findings) console.log(`  [${f.owner}] ${f.code} x${f.count}`);
process.exit(lost ? 1 : 0);
