import type { Config } from "./config.js";

/** Hermes said no, and this is what it said. */
export class HermesError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`Hermes ${status}: ${body.slice(0, 200)}`);
  }
}

/** The network isn't there. Distinct from Hermes answering with a refusal. */
export class OfflineError extends Error {}

export interface SyncBlockRow {
  id: string;
  blockTypeId: string | null;
  collectionKind: string | null;
  content: string | null;
  properties: Record<string, unknown>;
  version: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  memberships: MembershipRow[];
}

export interface MembershipRow {
  collectionId: string;
  position: string | null;
  region: string | null;
  context: Record<string, unknown>;
  hidden: boolean;
}

export interface ChangeRow {
  seq: number;
  blockId: string;
  op: "insert" | "update" | "delete";
  version: number | null;
  at: string;
}

const TIMEOUT_MS = 20_000;

/**
 * The only thing in the daemon that talks to Hermes.
 *
 * It draws one distinction the rest of the daemon leans on hard: a request that
 * never reached Hermes (`OfflineError`) versus one that reached it and was
 * refused (`HermesError`). The first means try again later and say nothing; the
 * second means something is actually wrong and the user should hear about it.
 * Conflating them is how an expired key turns into a mirror that has silently
 * stopped updating.
 */
export class Hermes {
  constructor(private config: Config) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${this.config.origin.replace(/\/$/, "")}/api${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.accessKey}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      // DNS failure, refused connection, timeout — all "not reachable", none of
      // them anything Hermes has an opinion about.
      throw new OfflineError((err as Error).message);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    if (!res.ok) throw new HermesError(res.status, text);
    return (text ? JSON.parse(text) : null) as T;
  }

  /** One page of the whole-account walk. */
  blocksPage(after?: string, limit = 1000) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (after) q.set("after", after);
    return this.req<{ blocks: SyncBlockRow[]; seq: number; next: string | null; payloadVersion?: number }>(
      "GET",
      `/sync/blocks?${q}`,
    );
  }

  /** Named blocks, in the same shape as a page of the walk. */
  blocksByIds(ids: string[]) {
    return this.req<{ blocks: SyncBlockRow[]; seq: number; next: null }>(
      "GET",
      `/sync/blocks?ids=${ids.join(",")}`,
    );
  }

  /** What has moved since a cursor. */
  changes(since: number, limit = 1000) {
    return this.req<{ changes: ChangeRow[]; nextSeq: number; more: boolean; pruned: boolean }>(
      "GET",
      `/sync/changes?since=${since}&limit=${limit}`,
    );
  }

  /**
   * Which blocks a filter query matches, asked of Hermes rather than worked out
   * here.
   *
   * The filter language is Hermes' — types, tags, properties, relative dates,
   * nested groups — and re-implementing its evaluator would be a second
   * source of truth for what a query means, which is the thing this project is
   * built not to have. So the server answers, and the answer is cached for
   * when it can't be asked.
   */
  queryMatches(filterQuery: unknown) {
    return this.req<{ id: string }[]>("POST", "/blocks/query", { filterQuery });
  }

  blockTypes() {
    return this.req<
      { id: string; name: string; propertySchema: unknown; isText: boolean; builtin: boolean }[]
    >("GET", "/block-types");
  }

  block(id: string) {
    return this.req<SyncBlockRow & { embedSource?: unknown }>("GET", `/blocks/${id}`);
  }

  createBlock(input: { id: string; blockTypeId?: string; content?: string; properties?: Record<string, unknown> }) {
    return this.req<SyncBlockRow>("POST", "/blocks", input);
  }

  patchBlock(id: string, input: { version: number; content?: string; properties?: Record<string, unknown> }) {
    return this.req<SyncBlockRow>("PATCH", `/blocks/${id}`, input);
  }

  /**
   * Where a block sits inside a collection, adding it if it isn't in one yet.
   *
   * A card dragged out of a smart matrix's drawer has never been a member — the
   * drawer is what the query matched, not what has been placed — so patching
   * its membership finds nothing to patch. Placing and joining are the same
   * gesture from the user's end, so they are one call from here.
   */
  async placeMember(collectionId: string, blockId: string, context: Record<string, unknown>) {
    try {
      return await this.req<unknown>("PATCH", `/collections/${collectionId}/members/${blockId}`, { context });
    } catch (err) {
      if (err instanceof HermesError && err.status === 404) {
        return await this.req<unknown>("POST", `/collections/${collectionId}/members`, { blockId, context });
      }
      throw err;
    }
  }

  dailyNote(date: string) {
    return this.req<{ id: string; content: string | null; version: number }>("GET", `/today/${date}/note`);
  }

  /** Cheapest possible "is it there and does it know me". */
  async reachable(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.blockTypes();
      return { ok: true, detail: "reachable, key accepted" };
    } catch (err) {
      if (err instanceof OfflineError) return { ok: false, detail: `unreachable: ${err.message}` };
      if (err instanceof HermesError && err.status === 401)
        return { ok: false, detail: "reachable, but the access key was refused" };
      return { ok: false, detail: (err as Error).message };
    }
  }
}
