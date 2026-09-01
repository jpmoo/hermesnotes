/**
 * Does the canvas mapping hold its shape?
 *
 * Pure, so it can be asked directly. The failures worth catching here are not
 * crashes — they are a canvas that comes back subtly rearranged, which looks
 * like the user misremembering where they put something and is the hardest
 * class of bug to be told about.
 */
import {
  contextOf,
  documentFrom,
  itemFrom,
  sameContext,
  writesFor,
  type CanvasDocument,
  type Collection,
} from "./src/canvas.js";

let bad = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `   ${detail}` : ""}`);
  if (!ok) bad += 1;
};

const node = (over: Record<string, unknown> = {}) => ({
  id: "i1",
  x: 10,
  y: 20,
  w: 130,
  h: 90,
  shape: "rectangle",
  fill: "#00ffdd",
  strokeWidth: 1.5,
  strokeStyle: "solid",
  hAlign: "center",
  vAlign: "middle",
  ...over,
});

console.log("\ncanvas mapping\n");

// ── the bag ────────────────────────────────────────────────────────────────
const bag = contextOf(node({ blockId: "b1" }) as never);
check("position and size use Hermes' own names", bag.x === 10 && bag.y === 20 && bag.w === 130 && bag.h === 90);
check("fill travels as `color`, which Hermes' canvas reads", bag.color === "#00ffdd");
check("shape travels under its own name", bag.shape === "rectangle");
check("the item's identity is in the bag", bag.itemId === "i1");
check(
  "no key is prefixed — the context bag is the one place the prefix rule does not reach",
  Object.keys(bag).every((k) => !k.includes(":")),
  Object.keys(bag).join(","),
);
check(
  "a linked node carries no copy of its title",
  !("text" in bag),
  "a second version of a fact drifts the moment somebody renames the block",
);

// ── and back ───────────────────────────────────────────────────────────────
const back = itemFrom({ object: "b1", context: bag }, "MINTED");
check("a round trip keeps the item's own id", back.id === "i1");
check("a round trip keeps the block it stands for", back.blockId === "b1");
check(
  "a round trip keeps every value",
  back.x === 10 && back.y === 20 && back.w === 130 && back.h === 90 && back.fill === "#00ffdd" && back.shape === "rectangle",
);
check(
  "a member nobody here placed still becomes a node",
  itemFrom({ object: "b9" }, "MINTED").id === "MINTED",
  "the assistant placing a task is exactly this case",
);

// ── the whole document ─────────────────────────────────────────────────────
const collection: Collection = {
  id: "c1",
  kind: "canvas",
  version: 3,
  members: [
    { object: "b1", version: 7, context: { ...bag } },
    { object: "b2", version: 2, context: { x: 400, y: 0, w: 200, h: 100, itemId: "i2" } },
  ],
  properties: {
    // The half Hermes draws, and the half only we do — joined on the id.
    "hermes:canvas_notes": [{ id: "note1", x: 10, y: 20, w: 130, h: 90, text: "a sticky", color: "#00ffdd" }],
    "talaria:itemExtras": [{ id: "note1", shape: "rectangle", hAlign: "center", vAlign: "middle" }],
    "talaria:links": [{ id: "l1", from: "i1", to: "note1" }],
    "talaria:regions": [{ id: "r1", members: ["i1"], title: "Ideas" }],
  },
};
let minted = 0;
const doc = documentFrom(collection, () => `m${++minted}`);
check("members and our own items both arrive", doc.items.length === 3);
check("links arrive", doc.links.length === 1 && doc.links[0]!.id === "l1");
check("regions arrive", doc.regions.length === 1 && doc.regions[0]!.title === "Ideas");
check(
  "a region still names an item that exists",
  doc.items.some((i) => i.id === doc.regions[0]!.members[0]),
  "this is what a fresh id every sync would break",
);

// ── what to write ──────────────────────────────────────────────────────────
const edited: CanvasDocument = {
  items: [
    { ...(node({ blockId: "b1", x: 999 }) as never) },
    { ...(node({ id: "i3", blockId: "b3" }) as never) },
    { ...(node({ id: "note1", text: "a sticky" }) as never) },
  ],
  links: [],
  regions: [],
};
const w = writesFor(edited, collection);
check("a moved node is a place, carrying the version it saw", w.place.length === 1 && w.place[0]!.version === 7);
check("the move actually carries the new position", (w.place[0]!.context as { x: number }).x === 999);
check("a node new to the canvas is an add", w.add.length === 1 && w.add[0]!.object === "b3");
check(
  "a node no longer on the canvas is a removal",
  writesFor(edited, collection, ["b1", "b2"]).remove.join() === "b2",
  "and only because the canvas had read it — see the case below",
);
check(
  "a member the canvas never read is left alone",
  writesFor(edited, collection).remove.length === 0,
  "the assistant's task, deleted by the next save because absence was read as deletion",
);
check(
  "having read some members does not license removing others",
  writesFor(edited, collection, ["b1"]).remove.length === 0,
);
check(
  "an unlinked item is collection furniture, never a member",
  (w.properties["hermes:canvas_notes"] as unknown[]).length === 1 &&
    !w.place.some((p) => p.object === "note1") &&
    !w.add.some((p) => p.object === "note1"),
);
check(
  "an unlinked item travels as a note Hermes can actually draw",
  (() => {
    const n = (w.properties["hermes:canvas_notes"] as Record<string, unknown>[])[0]!;
    return n.id === "note1" && n.x === 10 && n.text === "a sticky" && n.color === "#00ffdd";
  })(),
  "under our prefix alone it travelled correctly and rendered as nothing",
);
check(
  "what Hermes cannot draw rides beside it, keyed by the same id",
  (() => {
    const e = (w.properties["talaria:itemExtras"] as Record<string, unknown>[])[0]!;
    return e.id === "note1" && e.shape === "rectangle" && !("x" in e) && !("text" in e);
  })(),
);
check(
  "every key is somebody's, none the format's",
  Object.keys(w.properties).every((k) => k.includes(":")),
  Object.keys(w.properties).join(","),
);
check(
  "the mirror's spelling of Hermes' key reads too",
  (() => {
    const asMirrored: Collection = {
      id: "c1",
      // No prefix: this is how Talaria's own mirror stores the producer's keys.
      properties: { canvas_notes: [{ id: "n1", x: 1, y: 2, w: 3, h: 4, text: "bare", color: null }] },
    };
    return documentFrom(asMirrored, () => "x").items[0]?.text === "bare";
  })(),
  "the write goes out prefixed and the read comes back bare; both are the same key",
);
check(
  "a note moved in Hermes comes back moved",
  (() => {
    const moved: Collection = {
      id: "c1",
      properties: {
        "hermes:canvas_notes": [{ id: "note1", x: 555, y: 5, w: 130, h: 90, text: "edited there", color: null }],
        "talaria:itemExtras": [{ id: "note1", shape: "circle" }],
      },
    };
    const out = documentFrom(moved, () => "x").items[0]!;
    // Hermes wins on what both know; ours survives on what only we know.
    return out.x === 555 && out.text === "edited there" && out.shape === "circle";
  })(),
);
check(
  "a canvas that did not change asks for no writes at all",
  (() => {
    const same = documentFrom(collection, () => "x");
    const out = writesFor(same, collection);
    return out.add.length === 0 && out.remove.length === 0 && out.place.length === 0;
  })(),
  "places included — checking only adds and removals is what let an idle save rewrite every node",
);
check(
  "only the node that moved is written",
  (() => {
    const doc2 = documentFrom(collection, () => "x");
    doc2.items[0]!.x = 777;
    const out = writesFor(doc2, collection);
    return out.place.length === 1 && (out.place[0]!.context as { x: number }).x === 777;
  })(),
);
check(
  "a member somebody else placed is claimed on the next save",
  (() => {
    // No `itemId` — the assistant put this one here. Reading it mints an
    // identity, and the next save writes that identity back, which is how a
    // node the canvas did not create becomes one it can put in a region.
    const theirs: Collection = {
      id: "c1",
      members: [{ object: "b9", version: 1, context: { x: 1, y: 2, w: 3, h: 4 } }],
    };
    const out = writesFor(documentFrom(theirs, () => "minted"), theirs);
    return out.place.length === 1 && (out.place[0]!.context as { itemId: string }).itemId === "minted";
  })(),
);

// ── the comparison ─────────────────────────────────────────────────────────
check("an unchanged bag compares equal", sameContext(bag, { ...bag }));
check("a moved bag does not", !sameContext(bag, { ...bag, x: 11 }));
check("a bag that lost a key does not", !sameContext(bag, { ...bag, shape: undefined }));

console.log(bad ? `\n${bad} failed\n` : "\nall good\n");
process.exit(bad ? 1 : 0);
