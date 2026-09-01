/**
 * Do the canvas tools draw what they say they draw?
 *
 * The loop needs a tool-capable model and this does not: the model decides
 * which tool to call and these decide what the canvas becomes, and only the
 * second is ours to get right. Run against a scratch canvas in a temp home, so
 * it never touches the one somebody is using.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TALARIA_HOME = mkdtempSync(join(tmpdir(), "talaria-canvas-"));

const { tools } = await import("./src/canvasagent.js");
const { readCanvas } = await import("./src/canvas.js");

let bad = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `   ${detail}` : ""}`);
  if (!ok) bad += 1;
};

// The search tool is the only one that touches the network, and nothing here
// exercises it — a stub is enough to build the registry.
const ix = { search: async () => ({ objects: [] }) } as never;
const t = new Map(tools(ix).map((x) => [x.name, x]));
const run = async (name: string, args: Record<string, unknown>) => {
  const tool = t.get(name)!;
  return String(await tool.run(tool.schema.parse(args) as Record<string, unknown>));
};

console.log("\ncanvas tools\n");

check("an empty canvas says so", (await run("canvas_read", {})).includes("empty"));

await run("canvas_add", { texts: ["Draft", "Review", "Ship"], shape: "rectangle", fill: "#f97316" });
let d = readCanvas();
check("three nodes arrive in one call", d.items.length === 3);
check("each wears what was asked for", d.items.every((i) => i.shape === "rectangle" && i.fill === "#f97316"));
check(
  "they do not land on top of each other",
  new Set(d.items.map((i) => `${i.x},${i.y}`)).size === 3,
  "a chat that stacks its nodes looks like a broken canvas",
);

check("a node is found by its words", (await run("canvas_restyle", { nodes: ["Draft"], shape: "ellipse" })).includes("1"));
d = readCanvas();
check("and only that node changed", d.items.filter((i) => i.shape === "ellipse").length === 1);

const missing = await run("canvas_restyle", { nodes: ["Draft", "Nonexistent"] });
check("a name that matches nothing is named back", missing.includes("Nonexistent"), missing);

await run("canvas_connect", { from: "Draft", to: "Ship" });
d = readCanvas();
check("a connection joins the two it named", d.links.length === 1);
check(
  "by id, not by the words",
  d.links[0]!.from === d.items.find((i) => i.text === "Draft")!.id,
  "words change; a link that stored them would come apart on a rename",
);
check("a node cannot be joined to itself", (await run("canvas_connect", { from: "Draft", to: "Draft" })).includes("itself"));

await run("canvas_group", { nodes: ["Draft", "Review"], title: "Blockers" });
d = readCanvas();
check("a region holds what it was given", d.regions.length === 1 && d.regions[0]!.members.length === 2);

await run("canvas_remove", { nodes: ["Review"] });
d = readCanvas();
check("removing a node removes it", d.items.length === 2);
check("and the region it was in loses it", d.regions[0]!.members.length === 1);
await run("canvas_remove", { nodes: ["Draft"] });
d = readCanvas();
check(
  "a region emptied of all but nothing goes too",
  d.regions.length === 0,
  "a region around nothing is a box floating on the canvas",
);
check("a connection whose end has gone goes with it", d.links.length === 0);

check(
  "there is no tool that writes to Hermes",
  ![...t.keys()].some((n) => /create|complete|patch|write|delete|archive/.test(n) && !n.startsWith("canvas_")),
  [...t.keys()].join(", "),
);

console.log(bad ? `\n${bad} failed\n` : "\nall good\n");
process.exit(bad ? 1 : 0);
