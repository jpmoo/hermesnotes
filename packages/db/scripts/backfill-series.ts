/**
 * Move existing repeating tasks onto the series table.
 *
 *   pnpm series:backfill            # say what would happen, change nothing
 *   pnpm series:backfill --apply
 *   pnpm series:backfill --group    # also try to join occurrences into one series
 *
 * Dry by default because this is somebody's data and the interesting question —
 * which of these blocks are the same repeating thing — cannot be answered from
 * the data with certainty. Hermes has never recorded it.
 *
 * Without `--group`, every block carrying a rule becomes a series of one. That
 * is not a guess: it is the true statement that we do not know what came before.
 * From each task's next completion the new occurrence joins the series that now
 * exists, so a series grows forward from wherever it stands — the same shape as
 * pinning a month-day rather than pretending to reconstruct one.
 *
 * With `--group`, occurrences sharing an owner, a type, a title and a rule are
 * treated as one series. That is inference, it is usually right, and it is the
 * reason this prints what it intends to merge and waits to be told twice.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import postgres from "postgres";

config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env") });

const APPLY = process.argv.includes("--apply");
const GROUP = process.argv.includes("--group");

interface Row {
  id: string;
  owner_id: string;
  block_type_id: string | null;
  properties: Record<string, unknown>;
  series_id: string | null;
}

/** The rule as a series holds it: no `n`, because instances are countable. */
function ruleOf(raw: Record<string, unknown>): Record<string, unknown> {
  const { n: _n, ...rest } = raw;
  return rest;
}

/** What makes two occurrences the same repeating thing, when we are guessing. */
const identity = (r: Row, key: string) =>
  JSON.stringify([
    r.owner_id,
    r.block_type_id,
    String((r.properties.title as string) ?? "").trim().toLowerCase(),
    ruleOf(r.properties[key] as Record<string, unknown>),
  ]);

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const sql = postgres(url, { max: 1 });

  // Which property key carries the rule, per type. It is a field of type
  // "recurrence", and each type names it for itself — which is why this is a
  // script and not a line of SQL in the migration.
  const types = await sql<{ id: string; property_schema: { fields?: { key: string; type: string }[] } }[]>`
    SELECT id, property_schema FROM block_types`;
  const keyByType = new Map<string, string>();
  for (const t of types) {
    const f = (t.property_schema?.fields ?? []).find((x) => x.type === "recurrence");
    if (f) keyByType.set(t.id, f.key);
  }
  if (!keyByType.size) {
    console.log("No type declares a recurrence field. Nothing to do.");
    await sql.end();
    return;
  }

  const rows = await sql<Row[]>`
    SELECT id, owner_id, block_type_id, properties, series_id
      FROM blocks
     WHERE block_type_id = ANY(${sql.array([...keyByType.keys()])}::uuid[])`;

  const carrying = rows.filter((r) => {
    const key = keyByType.get(r.block_type_id!);
    const v = key ? r.properties[key] : null;
    return v !== null && v !== undefined && typeof v === "object";
  });
  // Idempotent: a block that already points at a series is done.
  const todo = carrying.filter((r) => !r.series_id);

  console.log(`${carrying.length} block(s) carry a rule; ${carrying.length - todo.length} already linked.`);
  if (!todo.length) {
    await sql.end();
    return;
  }

  // One bucket per series to create.
  const buckets = new Map<string, Row[]>();
  for (const r of todo) {
    const key = keyByType.get(r.block_type_id!)!;
    const bucket = GROUP ? identity(r, key) : r.id;
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), r]);
  }

  const merges = [...buckets.values()].filter((b) => b.length > 1);
  console.log(`${todo.length} block(s) to link, into ${buckets.size} series.`);
  if (GROUP && merges.length) {
    console.log(`\n${merges.length} series would take more than one occurrence:`);
    for (const b of merges) {
      const key = keyByType.get(b[0]!.block_type_id!)!;
      const rule = ruleOf(b[0]!.properties[key] as Record<string, unknown>);
      console.log(`  "${String(b[0]!.properties.title ?? "?")}" — ${b.length} occurrences, ${rule.frequency}`);
      for (const r of b) console.log(`      ${r.id}  n=${(r.properties[key] as { n?: number }).n ?? "-"}`);
    }
    console.log("\nThese are a guess: Hermes has never recorded which occurrences belong together.");
  } else if (!GROUP) {
    console.log("Each becomes a series of one. Pass --group to try joining them, and read what it proposes.");
  }

  if (!APPLY) {
    console.log("\nDry run. Nothing was written. Pass --apply to do it.");
    await sql.end();
    return;
  }

  let made = 0;
  try {
    // One transaction for the lot: a half-linked library is worse than an
    // unlinked one, because the second run would see the first half as done.
    await sql.begin(async (tx) => {
      for (const group of buckets.values()) {
        const first = group[0]!;
        const key = keyByType.get(first.block_type_id!)!;
        const rule = ruleOf(first.properties[key] as Record<string, unknown>);
        const [created] = await tx<{ id: string }[]>`
          INSERT INTO series (owner_id, rule) VALUES (${first.owner_id}, ${tx.json(rule)}) RETURNING id`;
        await tx`
          UPDATE blocks SET series_id = ${created!.id}
           WHERE id = ANY(${tx.array(group.map((r) => r.id))}::uuid[])`;
        made += 1;
      }
    });
    // The rule stays on the block as well, for now. Every read path still goes
    // there, and a migration that moved the data and the readers in one step
    // would be one that could not be checked.
    console.log(`\nDone. ${made} series created, ${todo.length} blocks linked.`);
    console.log("The rule is still on each block too — nothing reads the series yet.");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
