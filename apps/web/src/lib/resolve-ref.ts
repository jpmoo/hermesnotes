import { api, ApiError, type Block } from "../api.ts";

/** Current state of a linked block/collection target. `missing` = the row is
 *  gone (a genuine 404); `archived` = exists but archived; `live` = normal;
 *  `error` = a transient failure (network / 5xx) — NOT proof the target is gone. */
export type RefStatus = "live" | "archived" | "missing" | "error";

/**
 * Resolve a block/collection id to its current state — the shared primitive
 * behind consistent "archived"/"deleted" treatment wherever a stored reference
 * (mention, reference field, today section, review step) is rendered. GET
 * /blocks/:id returns archived blocks (they stay openable) and 404s deleted ones.
 * Only a 404 is treated as `missing`; any other error is `error`, so a server
 * hiccup never makes a live block render as deleted.
 */
export async function resolveRef(id: string): Promise<{ status: RefStatus; block: Block | null }> {
  try {
    const b = await api.get<Block>(`/blocks/${id}`);
    return { status: b.archivedAt ? "archived" : "live", block: b };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return { status: "missing", block: null };
    return { status: "error", block: null };
  }
}
