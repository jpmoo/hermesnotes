/**
 * Talaria's half of the binding.
 *
 * Everything Talaria knows about the library comes through here, in
 * `pkm-interchange/0` and nothing else. No `/sync/blocks`, no `/block-types`,
 * no Hermes vocabulary — the three routes below would work against any producer
 * claiming `operate` over http.
 *
 * What is deliberately *not* here: the chat surface and "Open in Hermes", which
 * are Hermes features rather than library data and have no business pretending
 * otherwise. Those still use the Hermes client, and that is the honest split.
 */

export class OfflineError extends Error {}
export class GoneError extends Error {}

export interface Conformance {
  produce?: number;
  consume?: number;
  operate?: number;
  bindings?: string[];
  profiles?: string[];
  features?: string[];
  unsupported?: string[];
}

export interface WriteAnswer {
  ok: boolean;
  conflict?: boolean;
  fidelity?: string;
  reports?: string[];
  cursor?: string;
  object?: Record<string, unknown>;
}

/** A promise the producer made that its answers do not keep. */
export interface Discrepancy {
  code: string;
  detail: string;
}

/**
 * Hold what a producer claimed against what it actually sent.
 *
 * The format asks a producer to fail loudly. This is the same rule pointed the
 * other way: a consumer that quietly copes with a surface not matching its
 * manifest is one that will keep coping, for months, while somebody wonders why
 * completing a task never sticks.
 *
 * The case this exists for is version skew, which no manifest can catch on its
 * own — `conformance` is compiled into the software and describes what the
 * build implements, so a deployment running last week's code claims everything
 * this week's code does. Only the answers can tell you.
 */
export function discrepancies(said: Conformance, env: Record<string, unknown>): Discrepancy[] {
  const out: Discrepancy[] = [];
  const objects = (env.objects ?? []) as { version?: number }[];
  const operates = (said.operate ?? 0) >= 4;

  if (operates && env.cursor === undefined) {
    out.push({
      code: "read.no-cursor",
      detail:
        "It claims a live surface and its reads carry no cursor, so there is no way to ask what has changed. Everything still works by reading the whole library every time, which is the difference between a sync and a download.",
    });
  }
  if (operates && objects.length && objects.every((o) => o.version === undefined)) {
    out.push({
      code: "read.no-version",
      detail:
        "It claims a live surface and its objects carry no version. A patch must present the version it expects, so nothing here can be written back safely — every write will be refused or, worse, accepted against state it never saw.",
    });
  }
  if ((said.produce ?? 0) >= 3 && env.findings === undefined && env.reports === undefined) {
    out.push({
      code: "read.no-reports",
      detail:
        "It claims to report what it could not express, and this answer reports nothing at all — not an empty list, no key. An export that says nothing is claiming to have lost nothing.",
    });
  }
  return out;
}

/**
 * What a board calls the region at a given index.
 *
 * The app counts cells, because a grid is drawn left to right and somebody
 * dragging a card is pointing at a square. The binding carries names, because a
 * square is a fact about one renderer. This is the only place the two meet.
 *
 * One implementation, exported, because there were two — both of which cast the
 * region list to `string[]` and indexed straight into it. That was true until a
 * region grew a label, and then a move sent the whole object where a name
 * belonged and every drag was refused. The cast is what silenced the compiler,
 * so the cast is gone.
 */
export function regionNameAt(
  board: { placement?: { regions?: (string | { name?: string })[] } } | null,
  index: number,
): string | null {
  const r = board?.placement?.regions?.[index];
  if (typeof r === "string") return r;
  return typeof r?.name === "string" ? r.name : null;
}

export class Interchange {
  constructor(
    private base: string,
    private token: () => string | null,
    private timeoutMs = 20000,
  ) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const token = this.token();
    let res: Response;
    try {
      res = await fetch(`${this.base.replace(/\/$/, "")}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      // Unreachable is an ordinary condition for this daemon, not an error.
      throw new OfflineError((err as Error).message);
    } finally {
      clearTimeout(timer);
    }
    // The producer saying it cannot answer this question. Not a failure — the
    // one honest answer to a cursor older than the log, and the signal to walk.
    if (res.status === 410) throw new GoneError(await res.text());
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  /**
   * What this instance honours.
   *
   * Asked before anything is written rather than discovered by trying, which is
   * the whole point of a manifest: an agent that has to attempt a write to learn
   * whether writes are supported has already done the damage if they are not.
   */
  conformance(): Promise<Conformance> {
    return this.req<Conformance>("GET", "/conformance");
  }

  /**
   * The library, or the part of it that was asked for.
   *
   * `since` is a cursor from a previous read and nothing else — never parsed,
   * never compared, never incremented. It is a sequence number in this producer
   * and has no business being one here.
   */
  read(opts: { since?: string; profile?: string } = {}): Promise<Record<string, unknown>> {
    const q = new URLSearchParams();
    if (opts.since !== undefined) q.set("since", opts.since);
    if (opts.profile) q.set("profile", opts.profile);
    const query = q.toString();
    return this.req<Record<string, unknown>>("GET", `/interchange${query ? `?${query}` : ""}`);
  }

  /**
   * Move an object to a named region of a collection.
   *
   * A name, never a coordinate. `urgent-important` survives being read by
   * something that draws no grid; `(340, 120)` is a fact about one renderer at
   * one zoom level, and the format will not carry it for exactly that reason.
   */
  async place(collection: string, object: string, region: string | null): Promise<WriteAnswer> {
    return this.answered(() =>
      this.req<WriteAnswer>("PATCH", `/interchange/collections/${collection}/members/${object}`, { region }),
    );
  }

  /**
   * A refused write is an answer, not a fault.
   *
   * "That region is not on this board" and "the network is down" call for
   * completely different things — re-read and tell the user, versus wait — and a
   * client that raises both as exceptions has thrown away the distinction its
   * caller most needs. Refusals come back as data; only the unreachable throws.
   */
  private async answered(call: () => Promise<WriteAnswer>): Promise<WriteAnswer> {
    try {
      return await call();
    } catch (err) {
      if (err instanceof OfflineError || err instanceof GoneError) throw err;
      const m = /^(4\d\d) (\{.*\})$/s.exec((err as Error).message);
      if (!m) throw err;
      const body = JSON.parse(m[2]!) as WriteAnswer;
      return { ...body, ok: false, conflict: m[1] === "409" || body.conflict };
    }
  }

  /**
   * Change part of an object.
   *
   * Two moves and no third: `set` what should hold these values, `unset` what
   * should hold none. A property named by neither is untouched, including every
   * property Talaria has never heard of — which is most of them, and the reason
   * a person can run this against a library it does not fully model.
   */
  async patch(
    id: string,
    change: { set?: Record<string, unknown>; unset?: string[]; version: number },
  ): Promise<WriteAnswer> {
    return this.answered(() => this.req<WriteAnswer>("PATCH", `/interchange/objects/${id}`, change));
  }
}
