/**
 * Talaria's canvas, as a collection the format can carry.
 *
 * The canvas is one document in Talaria and two different things in the format,
 * and the split is not arbitrary — it is the line between what is an object and
 * what is not.
 *
 * A node standing for a Hermes block is a **member**: it has an id anybody can
 * address, it can be linked to, and where it sits is `placement.context`, which
 * the format defines as furniture and says outright a consumer may discard. A
 * sticky note, a region and a connector are none of those things. They have no
 * id outside this producer, so they travel as the collection's own properties
 * under `talaria:` — which is the limit the format already writes down, met
 * head-on rather than worked around.
 *
 * **Where the two vocabularies coincide, Hermes' word wins.** Position is
 * `x`/`y`, size is `w`/`h`, and a background is `color`, because those are the
 * keys Hermes' own canvas reads. A Talaria canvas opened in Hermes then shows
 * its nodes in the right places in the right colors, instead of a default grid
 * of white boxes with all the real values sitting one key over. Only what
 * Hermes has no concept of — shape, stroke, alignment — takes a name of its
 * own, and those it discards, which is exactly what furniture is for.
 *
 * Pure, and no network in it. The rules are worth more than the plumbing here:
 * a mapping that loses a corner radius is a bug you find in a week, and a
 * mapping that loses which node was which is a canvas that reshuffles itself
 * every time it syncs.
 */

/** The keys Hermes' own canvas renderer understands. */
const SHARED = ["x", "y", "w", "h", "color"] as const;

/** Ours, and discardable by anything that is not us. */
const OWN = ["shape", "stroke", "strokeWidth", "strokeStyle", "hAlign", "vAlign", "text", "itemId"] as const;

export interface CanvasItem {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  shape?: string;
  fill?: string | null;
  stroke?: string | null;
  strokeWidth?: number;
  strokeStyle?: string;
  hAlign?: string;
  vAlign?: string;
  image?: string | null;
  /** The Hermes block this stands for, when it stands for one. */
  blockId?: string | null;
}

export interface CanvasLink {
  id: string;
  from: string;
  to: string;
  bendX?: number;
  bendY?: number;
  color?: string | null;
  width?: number;
  style?: string;
}

export interface CanvasRegion {
  id: string;
  members: string[];
  title?: string;
  hAlign?: string;
  textColor?: string | null;
  fill?: string | null;
  stroke?: string | null;
  strokeWidth?: number;
  strokeStyle?: string;
}

export interface CanvasDocument {
  items: CanvasItem[];
  links: CanvasLink[];
  regions: CanvasRegion[];
}

export interface Member {
  object: string;
  position?: string;
  version?: number;
  context?: Record<string, unknown>;
}

export interface Collection {
  id: string;
  kind?: string;
  version?: number;
  properties?: Record<string, unknown>;
  members?: Member[];
}

/** The prefix everything of ours travels under, on the collection itself. */
export const OURS = "talaria:";
const K_ITEMS = `${OURS}items`;
const K_LINKS = `${OURS}links`;
const K_REGIONS = `${OURS}regions`;

/**
 * One node's furniture, as the bag a member carries.
 *
 * `itemId` is in here and it is the part that matters. A canvas item has an
 * identity of its own that outlives which block it points at, and regions and
 * connectors name items by it — so an item that came back with a fresh id every
 * sync would leave every region empty and every line pointing at nothing. The
 * block id cannot stand in: two nodes may show the same block, and a node may
 * lose its block and still be a node.
 */
export function contextOf(item: CanvasItem): Record<string, unknown> {
  const bag: Record<string, unknown> = {
    x: item.x,
    y: item.y,
    w: item.w,
    h: item.h,
    itemId: item.id,
  };
  if (item.fill != null) bag.color = item.fill;
  if (item.shape !== undefined) bag.shape = item.shape;
  if (item.stroke != null) bag.stroke = item.stroke;
  if (item.strokeWidth !== undefined) bag.strokeWidth = item.strokeWidth;
  if (item.strokeStyle !== undefined) bag.strokeStyle = item.strokeStyle;
  if (item.hAlign !== undefined) bag.hAlign = item.hAlign;
  if (item.vAlign !== undefined) bag.vAlign = item.vAlign;
  // A linked node's words are its block's title, read live. Carrying a copy
  // here would be a second version of a fact, drifting from the first the
  // moment somebody renames the block — the same argument the format makes
  // against stamping a title onto an edge.
  return bag;
}

/** The reverse: a member's bag, read back as the node it describes. */
export function itemFrom(member: Member, fallbackId: string): CanvasItem {
  const c = (member.context ?? {}) as Record<string, unknown>;
  const num = (k: string, d: number) => (typeof c[k] === "number" ? (c[k] as number) : d);
  const str = (k: string) => (typeof c[k] === "string" ? (c[k] as string) : undefined);
  return {
    id: str("itemId") ?? fallbackId,
    blockId: member.object,
    x: num("x", 0),
    y: num("y", 0),
    w: num("w", 220),
    h: num("h", 120),
    fill: str("color") ?? null,
    shape: str("shape"),
    stroke: str("stroke") ?? null,
    strokeWidth: typeof c.strokeWidth === "number" ? (c.strokeWidth as number) : undefined,
    strokeStyle: str("strokeStyle"),
    hAlign: str("hAlign"),
    vAlign: str("vAlign"),
  };
}

/**
 * The whole canvas, read out of a collection.
 *
 * Members first, then whatever the collection carries under our own prefix. A
 * member with no `itemId` is one somebody else put on this canvas — the
 * assistant placing a task, most obviously — and it becomes an ordinary node
 * with an id minted for it, rather than being ignored because it did not come
 * from here.
 */
export function documentFrom(collection: Collection, mint: () => string): CanvasDocument {
  const items = (collection.members ?? []).map((m) => itemFrom(m, mint()));
  const props = (collection.properties ?? {}) as Record<string, unknown>;
  const arr = <T>(k: string): T[] => (Array.isArray(props[k]) ? (props[k] as T[]) : []);
  // Ours are appended after the members, so a note never sits under a block it
  // was drawn beside.
  return {
    items: [...items, ...arr<CanvasItem>(K_ITEMS)],
    links: arr<CanvasLink>(K_LINKS),
    regions: arr<CanvasRegion>(K_REGIONS),
  };
}

/**
 * What has to be written for this canvas to be that collection.
 *
 * Answers the pieces rather than performing them: which members should exist
 * with which bags, and what the collection's own keys should say. The caller
 * turns those into `place`, `PUT`, `DELETE` and `collectionPatch` — and being
 * able to ask this question without a network is what makes the mapping
 * testable at all.
 */
export function writesFor(
  doc: CanvasDocument,
  current: Collection,
): {
  place: { object: string; context: Record<string, unknown>; version?: number }[];
  add: { object: string; context: Record<string, unknown> }[];
  remove: string[];
  properties: Record<string, unknown>;
} {
  const linked = doc.items.filter((i) => i.blockId);
  const have = new Map((current.members ?? []).map((m) => [m.object, m]));
  const want = new Map(linked.map((i) => [i.blockId!, i]));

  const add: { object: string; context: Record<string, unknown> }[] = [];
  const place: { object: string; context: Record<string, unknown>; version?: number }[] = [];
  for (const [object, item] of want) {
    const bag = contextOf(item);
    const existing = have.get(object);
    if (!existing) add.push({ object, context: bag });
    else place.push({ object, context: bag, version: existing.version });
  }

  // A member here and not on the canvas is one the canvas dropped. Removing the
  // membership is the whole of it: the block goes on existing, which is the
  // rule this canvas has had since it learned to link at all.
  const remove = [...have.keys()].filter((o) => !want.has(o));

  return {
    place,
    add,
    remove,
    properties: {
      [K_ITEMS]: doc.items.filter((i) => !i.blockId),
      [K_LINKS]: doc.links,
      [K_REGIONS]: doc.regions,
    },
  };
}

/** For a caller that wants to know whether anything actually moved. */
export function sameContext(a: Record<string, unknown> = {}, b: Record<string, unknown> = {}): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b), ...SHARED, ...OWN]);
  for (const k of keys) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
  return true;
}
