/**
 * What comes back in, and whether it survives being a label.
 *
 * The exporter learned that a region has a name and a face; the importer was
 * never told. It casts `placement.regions` to `string[]` and matches a member's
 * region against it with `indexOf` — true until a region grew a label, and then
 * every card on that board loses its placement and the export is blamed for it.
 *
 * The same cast, in the same shape, as the one Talaria already found on its own
 * side. It survived here because no test library had a labeled region.
 */
import { fromInterchange } from "./src/import.js";

let bad = 0;
const check = (n: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${n}${d ? `   ${d}` : ""}`);
  if (!ok) bad += 1;
};

const envelope = {
  format: "pkm-interchange/0",
  types: [{ id: "t", name: "Task", fields: [{ key: "title", kind: "text" }] }],
  objects: [
    { id: "o1", type: "t", properties: { title: "In a plain region" } },
    { id: "o2", type: "t", properties: { title: "In a labeled one" } },
  ],
  collections: [
    {
      id: "c1",
      name: "Board",
      kind: "matrix",
      placement: {
        semantic: true,
        regions: ["do", { name: "delegate-wait", label: "Delegate & Wait", "hermes:color": "#6f93a9" }],
      },
      members: [
        { object: "o1", region: "do" },
        { object: "o2", region: "delegate-wait" },
      ],
    },
  ],
};

const back = fromInterchange(envelope as never);
const board = back.blocks.find((b) => b.id === "c1") as { properties: Record<string, unknown> };
const regions = board.properties.matrix_regions as { title?: unknown }[];
const placed = (id: string) =>
  (back.memberships.find((m) => m.blockId === id)?.context as { region?: number } | undefined)?.region;

console.log(`  matrix_regions: ${JSON.stringify(regions)}`);
console.log(`  memberships:    ${JSON.stringify(back.memberships.map((m) => ({ b: m.blockId, ctx: m.context })))}`);
console.log(`  findings:       ${JSON.stringify(back.findings.map((f) => f.code))}\n`);

check("a bare region keeps its card", placed("o1") === 0, `region ${placed("o1")}`);
check("a labeled region keeps its card too", placed("o2") === 1, `region ${placed("o2")}`);
check(
  "the rebuilt region titles are strings, not objects",
  regions.every((r) => typeof r.title === "string"),
  JSON.stringify(regions.map((r) => typeof r.title)),
);
check(
  "the labeled region comes back under the words a person reads",
  regions[1]?.title === "Delegate & Wait",
  JSON.stringify(regions[1]?.title),
);
check(
  "nothing is blamed on the format",
  !back.findings.some((f) => f.code === "placement.region-not-declared"),
  back.findings.map((f) => f.code).join(", ") || "no findings",
);

console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
