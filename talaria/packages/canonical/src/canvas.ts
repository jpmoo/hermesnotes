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
/**
 * The extras on an unlinked node, keyed by the note's own id.
 *
 * Not the whole node: the half Hermes can draw goes in `hermes:canvas_notes`
 * below, and this carries only what Hermes has no concept of. The same split as
 * a member's bag, one noun along, and for the same reason — a Talaria canvas
 * opened in Hermes should show its notes rather than nothing.
 */
const K_EXTRAS = `${OURS}itemExtras`;
const K_LINKS = `${OURS}links`;
const K_REGIONS = `${OURS}regions`;
/**
 * Hermes' own sticky notes.
 *
 * Deliberately another producer's key, and worth being explicit about. It is
 * not a way around the prefix rule — a prefixed key is exactly what the format
 * says a producer's own property looks like, and it round-trips untouched
 * through anything that has never heard of either of us. But it *is*
 * Hermes-specific knowledge: Talaria writes here because it knows what Hermes
 * draws, and against a different producer these notes would travel and simply
 * not be rendered.
 *
 * The alternative was keeping them under our prefix alone, which is purer and
 * produced a canvas that was blank in Hermes — every unlinked node invisible,
 * because nothing there knew the key. A format that carries a thing nobody can
 * see is carrying it in name only.
 */
const K_NOTES = "hermes:canvas_notes";
/**
 * The same key, as the mirror spells it.
 *
 * Talaria's sync strips the producer's own prefix when it stores an export —
 * from in here, Hermes' keys are simply Hermes', and carrying the prefix around
 * locally would be repeating the producer's name on every one of them. So a
 * write goes out prefixed and a read comes back bare, and both spellings are
 * the same key.
 *
 * Reading only the prefixed one is what made the notes travel perfectly and
 * come back as nothing: the write landed, the export showed it, and the mirror
 * had it under a name the reader was not looking for.
 */
const K_NOTES_BARE = "canvas_notes";

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

  // A note is the shared half plus our extras, joined on its id. The shared
  // half is authoritative: a note dragged in Hermes moved, and reading our own
  // copy over the top would put it back.
  const extras = new Map(arr<CanvasItem & { id: string }>(K_EXTRAS).map((e) => [e.id, e]));
  type Note = { id: string; x: number; y: number; w: number; h: number; text?: string; color?: string | null };
  const rawNotes = arr<Note>(K_NOTES).length ? arr<Note>(K_NOTES) : arr<Note>(K_NOTES_BARE);
  const notes = rawNotes.map((n) => {
    const extra = extras.get(n.id) ?? ({} as Partial<CanvasItem>);
    return {
      ...extra,
      id: n.id,
      x: n.x,
      y: n.y,
      w: n.w,
      h: n.h,
      text: n.text ?? "",
      fill: n.color ?? null,
      blockId: null,
    } as CanvasItem;
  });

  // Ours are appended after the members, so a note never sits under a block it
  // was drawn beside.
  return {
    items: [...items, ...notes],
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
  /**
   * The members this canvas knows about — what it last read, not what it holds.
   *
   * Without it a removal is computed as "in the collection and not in my
   * document", and those are two different facts wearing the same shape. A node
   * the user deleted is absent from the document; so is a node somebody added
   * while the app was closed, and the second one is not ours to remove.
   *
   * It cost a real block: the assistant put a task on this canvas, the app had
   * never heard of it, and the next save deleted the membership and reported
   * success. Nothing anywhere said so.
   *
   * Undefined means "I have read nothing", which removes nothing at all. That
   * is the right first run: a canvas that has never synced has no basis for
   * saying anything should go.
   */
  known?: Iterable<string>,
): {
  place: { object: string; context: Record<string, unknown>; version?: number }[];
  add: { object: string; context: Record<string, unknown> }[];
  remove: string[];
  properties: Record<string, unknown>;
} {
  const linked = doc.items.filter((i) => i.blockId);
  const unlinked = doc.items.filter((i) => !i.blockId);
  const have = new Map((current.members ?? []).map((m) => [m.object, m]));
  const want = new Map(linked.map((i) => [i.blockId!, i]));

  const add: { object: string; context: Record<string, unknown> }[] = [];
  const place: { object: string; context: Record<string, unknown>; version?: number }[] = [];
  for (const [object, item] of want) {
    const bag = contextOf(item);
    const existing = have.get(object);
    if (!existing) {
      add.push({ object, context: bag });
      continue;
    }
    // Only what moved.
    //
    // Emitting a place for every member turned an idle save into a rewrite of
    // the whole board — and worse than the traffic, every one of those carries
    // a version, so a canvas nobody had touched would collect conflicts against
    // whoever *had* touched it and log them as contention. A save that changes
    // nothing must ask for nothing.
    if (!sameContext(existing.context, bag)) {
      place.push({ object, context: bag, version: existing.version });
    }
  }

  // Gone from a canvas that had it. Removing the membership is the whole of it:
  // the block goes on existing, which is the rule this canvas has had since it
  // learned to link at all.
  const seen = known === undefined ? null : new Set(known);
  const remove = [...have.keys()].filter((o) => !want.has(o) && (seen === null ? false : seen.has(o)));

  return {
    place,
    add,
    remove,
    properties: {
      // The half Hermes draws…
      [K_NOTES]: unlinked.map((i) => ({
        id: i.id,
        x: i.x,
        y: i.y,
        w: i.w,
        h: i.h,
        text: i.text ?? "",
        color: i.fill ?? null,
      })),
      // …and the half only we do, keyed by the same id.
      [K_EXTRAS]: unlinked
        .map((i) => ({
          id: i.id,
          ...(i.shape === undefined ? {} : { shape: i.shape }),
          ...(i.stroke == null ? {} : { stroke: i.stroke }),
          ...(i.strokeWidth === undefined ? {} : { strokeWidth: i.strokeWidth }),
          ...(i.strokeStyle === undefined ? {} : { strokeStyle: i.strokeStyle }),
          ...(i.hAlign === undefined ? {} : { hAlign: i.hAlign }),
          ...(i.vAlign === undefined ? {} : { vAlign: i.vAlign }),
        }))
        // A note with nothing Hermes cannot draw needs no row here at all.
        .filter((e) => Object.keys(e).length > 1),
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
