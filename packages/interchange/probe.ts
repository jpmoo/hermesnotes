/**
 * Export a real library and say what could not be said.
 *
 * Reads Hermes' database when DATABASE_URL is set — which is the case on the
 * server, where the data actually lives — and Talaria's mirror otherwise.
 */
import { writeFileSync } from "node:fs";
import { toInterchange } from "./src/index.js";
import { loadLibrary } from "./source.js";

const lib = await loadLibrary();
const { envelope, findings } = toInterchange({
  types: lib.types,
  blocks: lib.blocks,
  memberships: lib.memberships,
  seriesRows: lib.seriesRows,
  producer: { name: "hermes", version: "2.0.0" },
});

const e = envelope as Record<string, unknown[]>;
console.log(`read ${lib.from}`);
console.log(
  `exported  ${e.types.length} types  ${e.objects.length} objects  ` +
    `${e.collections.length} collections  ${(e.series ?? []).length} series  ${e.relations.length} relations`,
);
console.log(`\n${findings.length} finding(s):\n`);
for (const f of findings) {
  console.log(`  [${f.owner}] ${f.code}  ×${f.count}`);
  console.log(`      ${f.detail}\n`);
}
const out = process.argv[2];
if (out) {
  writeFileSync(out, JSON.stringify(envelope, null, 2));
  console.log(`written to ${out}`);
}
