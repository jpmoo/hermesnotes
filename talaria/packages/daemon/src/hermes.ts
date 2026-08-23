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

export interface FeedEvent {
  uid: string;
  summary: string;
  description: string;
  location: string;
  start: string;
  end: string | null;
  allDay: boolean;
  feedId: string;
  feedName: string;
  color: string;
}

export interface PendingCall {
  tool: string;
  /** Whatever the tool takes; shapes differ per tool and none of it is ours. */
  args?: unknown;
}

export interface AssistantTurn {
  reply: string;
  steps: unknown[];
  pending: PendingCall[];
  stopped?: boolean;
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

  /**
   * External calendar-feed events for a window.
   *
   * The endpoint answers `{ events, stale }`, not a bare array — `stale` being
   * its way of saying a feed host didn't answer and these are the last known
   * ones, which is worth passing along rather than flattening away.
   */
  async feedEvents(start: string, end: string): Promise<{ events: FeedEvent[]; stale: boolean }> {
    const got = await this.req<{ events?: FeedEvent[]; stale?: boolean }>(
      "GET",
      `/calendar/events?start=${start}&end=${end}`,
    );
    return { events: got.events ?? [], stale: Boolean(got.stale) };
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
   * Where a block sits inside a collection, joining it if it isn't a member yet.
   *
   * Which of the two it is has to be decided by the caller, not discovered from
   * the response: patching a membership that doesn't exist updates no rows and
   * still answers `{ ok: true }`, so a create dressed as an edit reports success
   * and does nothing at all. A card dragged out of a smart matrix's drawer is
   * exactly that case — the drawer holds what the query matched, not what has
   * been placed.
   */
  async placeMember(
    collectionId: string,
    blockId: string,
    context: Record<string, unknown>,
    join: boolean,
  ) {
    if (join) {
      return await this.req<unknown>("POST", `/collections/${collectionId}/members`, { blockId, context });
    }
    return await this.req<unknown>("PATCH", `/collections/${collectionId}/members/${blockId}`, { context });
  }

  blockTags(blockId: string) {
    return this.req<string[]>("GET", `/blocks/${blockId}/tags`);
  }

  setBlockTags(blockId: string, tags: string[]) {
    return this.req<unknown>("PUT", `/blocks/${blockId}/tags`, { tags });
  }

  dailyNote(date: string) {
    return this.req<{ id: string; content: string | null; version: number }>("GET", `/today/${date}/note`);
  }

  /**
   * One turn with the Hermes assistant.
   *
   * The endpoint streams Server-Sent Events over the POST — tokens as the model
   * writes them, a line per tool call, then a final `done`. This consumes the
   * stream and hands back the finished turn: the model runs on the user's own
   * server against their own Ollama, so the interesting latency is the model
   * thinking, not the transport, and a panel that says so plainly is honest
   * enough without threading tokens all the way into Swift.
   *
   * `pending` is the part that matters. Anything destructive is not executed —
   * it comes back for a person to approve, and nothing happens until it does.
   */
  async assistant(message: string, signal?: AbortSignal): Promise<AssistantTurn> {
    let res: Response;
    try {
      res = await fetch(`${this.config.origin.replace(/\/$/, "")}/api/assistant/chat`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.accessKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ message }),
        signal,
      });
    } catch (err) {
      throw new OfflineError((err as Error).message);
    }
    if (!res.ok) throw new HermesError(res.status, await res.text());
    if (!res.body) throw new HermesError(502, "the assistant sent no stream");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let out: AssistantTurn = { reply: "", steps: [], pending: [] };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line; a partial one waits.
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        if (ev.type === "done") {
          out = {
            reply: String(ev.reply ?? ""),
            steps: Array.isArray(ev.steps) ? (ev.steps as unknown[]) : [],
            pending: Array.isArray(ev.pending) ? (ev.pending as PendingCall[]) : [],
            stopped: Boolean(ev.stopped),
          };
        } else if (ev.type === "error") {
          throw new HermesError(500, String(ev.error ?? "the assistant failed"));
        }
      }
    }
    return out;
  }

  /** Run the calls the assistant asked permission for. */
  assistantConfirm(calls: PendingCall[]) {
    return this.req<{ steps: unknown[] }>("POST", "/assistant/confirm", { calls });
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
