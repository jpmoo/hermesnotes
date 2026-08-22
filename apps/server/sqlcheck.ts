import { drizzle } from "drizzle-orm/postgres-js";
import { and, asc, eq, gt, lt, sql } from "drizzle-orm";
import { blocks, changes } from "@hermes/db";

const db = drizzle({} as never);
const uid = "11111111-2222-4333-8444-555555555555";

const mirrorView = {
  id: blocks.id,
  properties: blocks.properties,
  archivedAt: blocks.archivedAt,
  tags: sql<string[]>`COALESCE((
    SELECT array_agg(t.name ORDER BY t.name)
    FROM block_tags bt JOIN tags t ON t.id = bt.tag_id
    WHERE bt.block_id = blocks.id
  ), '{}')`,
};

const page = db
  .select(mirrorView)
  .from(blocks)
  .where(and(eq(blocks.ownerId, uid), gt(blocks.id, uid)))
  .orderBy(asc(blocks.id))
  .limit(1000);
console.log("--- /sync/blocks ---\n" + page.toSQL().sql);
console.log("params:", page.toSQL().params);

const span = db
  .select({
    oldest: sql<string | null>`MIN(${changes.seq})`,
    head: sql<string | null>`pg_sequence_last_value(pg_get_serial_sequence('changes', 'seq')::regclass)`,
  })
  .from(changes);
console.log("\n--- head/oldest ---\n" + span.toSQL().sql);

const log = db
  .select({ seq: changes.seq, blockId: changes.blockId })
  .from(changes)
  .where(
    and(
      eq(changes.ownerId, uid),
      gt(changes.seq, 42),
      lt(changes.at, sql`now() - ${`200 milliseconds`}::interval`),
    ),
  )
  .orderBy(asc(changes.seq))
  .limit(1000);
console.log("\n--- /sync/changes ---\n" + log.toSQL().sql);
console.log("params:", log.toSQL().params);
