import { api, type Block } from "../api.ts";
import { oneLineText } from "./display.ts";

/**
 * Just enough about a block to label it and decide where it lives — for the
 * places that hold an id and nothing else (the history menu, the nav model).
 * Fetched once per id and shared, so listing ten recents costs ten requests the
 * first time and none after.
 */
export interface BlockBrief {
  label: string;
  blockTypeId: string | null;
  properties?: Record<string, unknown>;
  document?: boolean;
  matrix?: boolean;
  table?: boolean;
  canvas?: boolean;
  calendar?: boolean;
  smart?: boolean;
}

const cache = new Map<string, Promise<BlockBrief>>();

export function blockBrief(id: string): Promise<BlockBrief> {
  const hit = cache.get(id);
  if (hit) return hit;
  const p = api
    .get<Block>(`/blocks/${id}`)
    .then(
      (b): BlockBrief => ({
        label: oneLineText(b.properties, b.content) || "Untitled",
        blockTypeId: b.blockTypeId,
        properties: b.properties,
        document: b.collectionKind === "document",
        matrix: b.collectionKind === "matrix",
        table: b.collectionKind === "table",
        canvas: b.collectionKind === "canvas",
        calendar: b.collectionKind === "calendar",
        smart: (b.properties as Record<string, unknown>)?.membership_mode === "smart",
      }),
    )
    .catch((): BlockBrief => ({ label: "(unknown)", blockTypeId: null }));
  cache.set(id, p);
  return p;
}
