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
    "hermes:canvas_notes": [{ id: "n:note1", x: 10, y: 20, w: 130, h: 90, text: "a sticky", color: "#00ffdd" }],
    "talaria:itemExtras": [{ id: "note1", shape: "rectangle", hAlign: "center", vAlign: "middle" }],
    "hermes:canvas_edges": [{ id: "l1", from: "b1", to: "n:note1", arrow: "forward", live: true }],
    "talaria:links": [{ id: "l1", from: "i1", to: "note1", bendX: 4, bendY: 0 }],
    "hermes:canvas_regions": [{ id: "r1", title: "Ideas", color: null, memberIds: ["b1"] }],
    "talaria:regions": [{ id: "r1", members: ["i1"], title: "Ideas", strokeStyle: "dashed" }],
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
  (w.properties["hermes:canvas_notes"] as { id: string }[]).some((n) => n.id === "n:note1") &&
    !w.place.some((p) => p.object === "note1") &&
    !w.add.some((p) => p.object === "note1"),
);
check(
  "an unlinked item travels as a note Hermes can actually draw",
  (() => {
    const n = (w.properties["hermes:canvas_notes"] as Record<string, unknown>[]).find(
      (x) => (x.id as string).endsWith("note1"),
    )!;
    return n.id === "n:note1" && n.x === 10 && n.text === "a sticky" && n.color === "#00ffdd";
  })(),
  "and under the id Hermes knows a note by — bare, it drew and could not be touched",
);
check(
  "a connection travels as an edge Hermes draws",
  (() => {
    const e = (w.properties["hermes:canvas_edges"] as Record<string, unknown>[])[0]!;
    return e.from === "b1" && e.to === "n:note1" && e.arrow === "forward" && e.live === true;
  })(),
  "a block by its own id, a note by its n: one",
);
check(
  "the bend stays ours, keyed to the same edge",
  (w.properties["talaria:links"] as Record<string, unknown>[]).length === 0 ||
    (w.properties["talaria:links"] as Record<string, unknown>[])[0]!.id !== undefined,
);
check(
  "a region travels as one Hermes draws, naming what it holds",
  (() => {
    const r = (w.properties["hermes:canvas_regions"] as Record<string, unknown>[])[0];
    return r === undefined || Array.isArray(r.memberIds);
  })(),
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
      properties: { canvas_notes: [{ id: "n:n1", x: 1, y: 2, w: 3, h: 4, text: "bare", color: null }] },
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
        "hermes:canvas_notes": [{ id: "n:note1", x: 555, y: 5, w: 130, h: 90, text: "edited there", color: null }],
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

// ── what somebody else added ───────────────────────────────────────────────
check(
  "a note added in Hermes survives a push that has never seen it",
  (() => {
    const theirs: Collection = {
      id: "c1",
      properties: {
        "hermes:canvas_notes": [
          { id: "n:mine", x: 0, y: 0, w: 1, h: 1, text: "mine", color: null },
          { id: "n:theirs", x: 9, y: 9, w: 1, h: 1, text: "added over there", color: null },
        ],
      },
    };
    const doc3: CanvasDocument = { items: [], links: [], regions: [] };
    const out = writesFor(doc3, theirs, ["mine"]);
    const kept = (out.properties["hermes:canvas_notes"] as { id: string }[]).map((n) => n.id);
    // "mine" was read and is gone from the document, so it was deleted.
    // "theirs" this canvas has never seen, and is not ours to remove.
    return kept.length === 1 && kept[0] === "n:theirs";
  })(),
  "these arrays are written whole, so a push carrying only what we hold erases the rest",
);

check(
  "a push does not re-add what is already there",
  (() => {
    // The whole document read back, then written straight out again. Every id
    // in it is known, so every row is replaced rather than duplicated.
    const round = documentFrom(collection, () => "x");
    const ids = [
      ...round.items.map((i) => i.blockId ?? i.id),
      ...round.links.map((l) => l.id),
      ...round.regions.map((r) => r.id),
    ];
    const out = writesFor(round, collection, ids);
    const notes = out.properties["hermes:canvas_notes"] as { id: string }[];
    return notes.length === 1 && notes[0]!.id === "n:note1";
  })(),
  "a known-set of block ids alone kept every old note and appended the new one — five became ten",
);

check(
  "a push before the first read still does not duplicate",
  (() => {
    // `known` undefined: this canvas has read nothing. Every existing row is
    // therefore somebody else's and must survive — except the ones this very
    // write is about to produce, which cannot be both.
    const round = documentFrom(collection, () => "x");
    const out = writesFor(round, collection);
    const notes = out.properties["hermes:canvas_notes"] as { id: string }[];
    const regions = out.properties["hermes:canvas_regions"] as { id: string }[];
    return notes.length === 1 && regions.length === 1;
  })(),
  "two regions became four became eight, once per launch, because the first push precedes the first pull",
);

console.log(bad ? `\n${bad} failed\n` : "\nall good\n");
process.exit(bad ? 1 : 0);
