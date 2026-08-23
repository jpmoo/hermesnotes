/**
 * The exporter, run against a real library.
 *
 * Reads Talaria's local mirror rather than the server: it holds the same rows,
 * it needs no deploy, and the point of this run is to find out what the format
 * cannot say about a real account before anything gets rewired around it.
 */
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { toInterchange } from "./src/index.js";
import type { HermesBlock, HermesMembership, HermesType } from "./src/types.js";

const db = new DatabaseSync(`${process.env.HOME}/Library/Application Support/Talaria/mirror.sqlite`);
const rows = <T>(sql: string) => (db.prepare(sql).all() as { raw?: string; [k: string]: unknown }[]) as T[];

const types = (rows<{ raw: string }>("select raw from block_types")).map(
  (r) => JSON.parse(r.raw) as HermesType,
);
const blocks = (rows<{ raw: string }>("select raw from blocks")).map((r) => JSON.parse(r.raw) as HermesBlock);
const memberships = (
  db.prepare("select collection_id, block_id, position, context from memberships").all() as {
    collection_id: string;
    block_id: string;
    position: string | null;
    context: string;
  }[]
).map<HermesMembership>((m) => ({
  collectionId: m.collection_id,
  blockId: m.block_id,
  position: m.position,
  context: JSON.parse(m.context ?? "{}") as Record<string, unknown>,
}));

const { envelope, findings } = toInterchange({
  types,
  blocks,
  memberships,
  producer: { name: "hermes", version: "2.0.0" },
});

const e = envelope as Record<string, unknown[]>;
console.log(
  `exported  ${e.types.length} types  ${e.objects.length} objects  ` +
    `${e.collections.length} collections  ${e.relations.length} relations`,
);
console.log(`\n${findings.length} finding(s):\n`);
for (const f of findings) {
  console.log(`  [${f.owner}] ${f.code}  ×${f.count}`);
  console.log(`      ${f.detail}\n`);
}
const out = process.argv[2] ?? "/tmp/hermes-export.json";
writeFileSync(out, JSON.stringify(envelope, null, 2));
console.log(`written to ${out}`);
