/*
 * `canvas.json`, and the shape Hermes' canvas expects to see.
 *
 * One document, held whole. The daemon's own note on the file says why there is
 * no merge and no read-set: "Every distributed-document problem this project has
 * met came from a canvas that was two documents; this one is one." The same
 * holds here — this module never patches fields into a document it has not got.
 */
import { ask, type Collection, type Member } from "./api.ts";

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
  textColor?: string | null;
  image?: string | null;
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
  /** Anything this build has never heard of, carried through untouched. */
  [unknown: string]: unknown;
}

/** One placed block, as the mirror knows it. */
export interface Linked {
  id: string;
  missing: boolean;
  title?: string;
  typeId?: string | null;
  status?: string | null;
  url?: string | null;
  archived?: boolean;
}

export const getDocument = () => ask<CanvasDocument>("GET", "/canvas/document");
export const putDocument = (doc: CanvasDocument) => ask<unknown>("PUT", "/canvas/document", doc);
export const getLinked = (ids: string[]) =>
  ids.length ? ask<Linked[]>("POST", "/linked", { ids }) : Promise.resolve([]);

/*
 * The two vocabularies.
 *
 * An item with no `blockId` is a note the canvas owns; an item with one stands
 * for a block that lives in the library. Hermes keeps the first kind in
 * `properties.canvas_notes` and the second as collection members with their
 * geometry in `member.context`, so that is the shape handed to the component —
 * and every field name below is Hermes' name for the same thing, which is what
 * makes the fork work without touching the component.
 */

const NOTE_ID = (id: string) => `n:${id}`;
export const isNoteId = (id: string) => id.startsWith("n:");
export const noteIdOf = (id: string) => (isNoteId(id) ? id.slice(2) : id);

/**
 * `properties.canvas_notes` — the notes, in Hermes' field names.
 *
 * Three of those names differ from Talaria's and all three matter: a note's id
 * carries an `n:` prefix in the component (it is how a note end is told from a
 * block end on a link), its paper color is `color` rather than `fill`, and its
 * members list is `memberIds`. Getting the first one wrong drew every region
 * around nothing; getting the second wrong drew every sticky white.
 */
function notesOf(doc: CanvasDocument) {
  return doc.items
    .filter((item) => !item.blockId)
    .map((item) => ({
      id: NOTE_ID(item.id),
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
      text: item.text ?? "",
      shape: item.shape ?? "plain",
      color: item.fill ?? null,
      stroke: item.stroke ?? null,
      strokeWidth: item.strokeWidth,
      strokeStyle: item.strokeStyle,
      hAlign: item.hAlign,
      vAlign: item.vAlign,
      textColor: item.textColor ?? null,
      /*
       * **Not passed through, on purpose.** Hermes' note carries its picture as
       * `{name, mime, data}` — the bytes, inline. Talaria stores a file name in
       * `canvas-images/` beside the document. Handing the component a string
       * where it expects an object makes it read `.data` off a string, and the
       * failure lands in the middle of converting a note rather than anywhere
       * near here. The file keeps its `image` either way; `itemFromNote` never
       * overwrites it.
       */
    }));
}

/** `properties.canvas_edges` — links, with Hermes' end names. */
function edgesOf(doc: CanvasDocument) {
  return doc.links.map((link) => ({
    id: link.id,
    // A link end is an item id; the component addresses notes as `n:<id>` and
    // blocks by their block id, so the ends are translated on the way out and
    // back again on the way in.
    from: endOut(doc, link.from),
    to: endOut(doc, link.to),
    bendX: link.bendX,
    bendY: link.bendY,
    color: link.color ?? undefined,
    width: link.width,
    dash: link.style,
  }));
}

function endOut(doc: CanvasDocument, itemId: string) {
  const item = doc.items.find((i) => i.id === itemId);
  if (item) return item.blockId ? item.blockId : NOTE_ID(itemId);
  // A region, which is a legitimate end: dropping a node on a region connects
  // to the region, and the component addresses one by its bare id — `rectOf`
  // looks regions up directly. Prefixing it would make the line point at a note
  // that does not exist, and the edge would silently not draw.
  if (doc.regions.some((rg) => rg.id === itemId)) return itemId;
  return NOTE_ID(itemId);
}

/** The other direction: what the component calls an end, as an item id. */
export function endIn(doc: CanvasDocument, end: string) {
  if (isNoteId(end)) return noteIdOf(end);
  if (doc.regions.some((rg) => rg.id === end)) return end;
  const item = doc.items.find((i) => i.blockId === end);
  return item?.id ?? end;
}

export function toCollection(doc: CanvasDocument): Collection {
  return {
    // A canvas rather than a collection: there is one, it is this file, and the
    // id is only ever used to build a URL this adapter answers itself.
    id: "canvas",
    collectionKind: "canvas",
    properties: {
      canvas_notes: notesOf(doc),
      canvas_edges: edgesOf(doc),
      // A region names its members the way the component addresses them, and
      // calls the list `memberIds`. Talaria stores item ids in `members`; the
      // two are the same set said differently.
      canvas_regions: doc.regions.map((region) => ({
        id: region.id,
        title: region.title ?? "",
        color: region.fill ?? undefined,
        memberIds: (region.members ?? []).map((id) => endOut(doc, id)),
      })),
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
  };
}

export function toMembers(doc: CanvasDocument, linked: Linked[]): Member[] {
  const known = new Map(linked.map((l) => [l.id, l]));
  return doc.items
    .filter((item) => item.blockId)
    .map((item, at) => {
      const block = known.get(item.blockId as string);
      return {
        membershipId: item.id,
        position: String(at),
        // Geometry lives in the membership on Hermes' side, which is exactly
        // where the component looks for it.
        context: {
          x: item.x,
          y: item.y,
          w: item.w,
          h: item.h,
          // `color` is the component's name for it — see `notesOf`.
          color: item.fill ?? null,
          hAlign: item.hAlign,
          vAlign: item.vAlign,
          textColor: item.textColor ?? null,
          stroke: item.stroke ?? null,
          strokeWidth: item.strokeWidth,
          strokeStyle: item.strokeStyle,
          shape: item.shape,
        },
        membershipVersion: 1,
        id: item.blockId as string,
        blockTypeId: block?.typeId ?? null,
        collectionKind: null,
        // The title, which is all a Talaria node shows. A block the mirror has
        // never heard of says so rather than rendering as an empty card — the
        // daemon draws that distinction deliberately and it would be a shame to
        // throw it away here.
        content: block?.missing === false ? (block.title ?? "") : null,
        properties: {
          talaria_status: block?.status ?? null,
          talaria_url: block?.url ?? null,
          talaria_archived: block?.archived ?? false,
          talaria_missing: block?.missing ?? true,
        },
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    });
}
