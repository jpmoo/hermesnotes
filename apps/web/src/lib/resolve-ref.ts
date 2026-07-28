import { api, type Block } from "../api.ts";

/** Current state of a linked block/collection target. `missing` = the row is
 *  gone (hard-deleted); `archived` = exists but archived; `live` = normal. */
export type RefStatus = "live" | "archived" | "missing";

/**
 * Resolve a block/collection id to its current state — the shared primitive
 * behind consistent "archived"/"deleted" treatment wherever a stored reference
 * (mention, reference field, today section, review step) is rendered. GET
 * /blocks/:id returns archived blocks (they stay openable) and 404s deleted ones.
 */
export async function resolveRef(id: string): Promise<{ status: RefStatus; block: Block | null }> {
  try {
    const b = await api.get<Block>(`/blocks/${id}`);
    return { status: b.archivedAt ? "archived" : "live", block: b };
  } catch {
    return { status: "missing", block: null };
  }
}
