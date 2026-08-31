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

/** The readable part of an error body: first meaningful line, hard-capped. */
function summarise(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "(no body)";
  // An HTML page has nothing useful in its first line, so say what it is
  // rather than quoting the doctype at somebody.
  if (/^\s*<(!doctype|html)/i.test(trimmed)) {
    const title = /<title>([^<]{1,120})<\/title>/i.exec(trimmed)?.[1]?.trim();
    return title ? `HTML page — "${title}"` : "an HTML page, not an API response";
  }
  const line = trimmed.split("\n")[0]!.trim();
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/**
 * The producer does not offer this verb.
 *
 * Distinct from a refusal, and the distinction decides what happens to the
 * write. A refusal is a decision — a stale version, a region that is not on
 * that board — and needs a person. This is a producer that has not been
 * upgraded yet, which is a condition that ends by itself, so the intent waits
 * the way an offline one waits rather than being parked for somebody to come
 * and retry by hand.
 *
 * The format makes the same distinction from the other side: capabilities are a
 * question you can ask, not something to discover by attempting a write. This
 * is what to do when you attempted it anyway.
 */
export class UnsupportedError extends Error {}

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
    // No such route, or a route that does not take this method. Either way the
    // producer does not implement this verb.
    if (res.status === 404 || res.status === 405) {
      throw new UnsupportedError(`this producer does not implement ${method} ${path}`);
    }
    const text = await res.text();
    // Capped, because a refusal is not always JSON. A proxy in front of a
    // server that is switched off answers with a full HTML error page, and
    // `talaria doctor` printed all two hundred lines of Cloudflare's into the
    // terminal under the heading "producer". The status and the first line of
    // it are the whole diagnostic; the rest is someone else's stylesheet.
    if (!res.ok) throw new Error(`${res.status} ${summarise(text)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  /**
   * Bring an object into being, at an id we chose.
   *
   * The verb the format did not have until it did — Talaria reached past the
   * binding to Hermes' `POST /blocks` for every task and note it made, which
   * was the largest remaining hole in the port and is now closed.
   *
   * Safe to replay, which is the property the queue is built on. The id is
   * decided here before anything is sent, so a create that went out and whose
   * answer was lost is recognisably the same create when it goes out again: the
   * producer answers `created: false` and changes nothing, rather than making a
   * second one.
   */
  put(
    id: string,
    object: { type?: string; properties?: Record<string, unknown>; content?: string },
  ): Promise<{ ok?: boolean; created?: boolean; object?: unknown; reports?: string[] }> {
    return this.req("PUT", `/interchange/objects/${id}`, object);
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
   * Is the far end there, and does it know us?
   *
   * Two questions with different answers, so two calls. `conformance` is
   * unauthenticated by design, which makes it the honest test of *reachable* —
   * a 401 from it would say nothing about the network. Then one scoped read,
   * from the cursor we already hold so it is usually an empty answer, to find
   * out whether the key is any good.
   *
   * Both through the binding. This used to ask for the producer's block types,
   * which proved reachability by way of a route only that producer has.
   */
  async reachable(cursor: string | null): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.conformance();
    } catch (err) {
      if (err instanceof OfflineError) return { ok: false, detail: `unreachable: ${err.message}` };
      return { ok: false, detail: (err as Error).message };
    }
    try {
      await this.read(cursor === null ? { profile: "__none__" } : { since: cursor });
      return { ok: true, detail: "reachable, key accepted" };
    } catch (err) {
      if (err instanceof GoneError) return { ok: true, detail: "reachable, key accepted (cursor aged out)" };
      if (err instanceof OfflineError) return { ok: false, detail: `unreachable: ${err.message}` };
      if (/^401 /.test((err as Error).message)) {
        return { ok: false, detail: "reachable, but the access key was refused" };
      }
      return { ok: false, detail: (err as Error).message };
    }
  }

  /**
   * What one collection holds now.
   *
   * The verb a cursor cannot replace. `since` says what *changed*, and a
   * computed membership changes without anything changing — a task whose date
   * fell into range today was not edited, so no feed carries it and no cursor
   * moves past it. A follower doing everything right still ends up holding a
   * list that quietly stopped being true, which is exactly what the boards were
   * doing before this existed.
   *
   * Throws `UnsupportedError` on a producer that has not implemented it, which
   * the caller treats as "keep the snapshot I already have" rather than as a
   * failure: it is a condition that ends when the far end is upgraded.
   */
  collection(id: string): Promise<Record<string, unknown>> {
    return this.req<Record<string, unknown>>("GET", `/interchange/collections/${id}`);
  }

  /**
   * Move an object to a named region of a collection.
   *
   * A name, never a coordinate. `urgent-important` survives being read by
   * something that draws no grid; `(340, 120)` is a fact about one renderer at
   * one zoom level, and the two are not interchangeable — see `arrange` below,
   * which is the other half and is refused on a board that works in names.
   */
  async place(collection: string, object: string, region: string | null): Promise<WriteAnswer> {
    return this.answered(() =>
      this.req<WriteAnswer>("PATCH", `/interchange/collections/${collection}/members/${object}`, { region }),
    );
  }

  /**
   * Move something on a canvas — or resize it, or recolour it.
   *
   * The furniture half of placement, and refused by the producer on a collection
   * whose placement is semantic, so this cannot be used to record a judgment
   * somewhere nothing can read it back.
   *
   * `context` merges and `unset` removes. Sending only what moved is the point:
   * Talaria draws a canvas node as a box and knows nothing about whatever else
   * the web app has hung on that member, and a write that replaced the bag would
   * delete it.
   */
  async arrange(
    collection: string,
    object: string,
    change: { context?: Record<string, unknown>; unset?: string[]; version?: number },
  ): Promise<WriteAnswer> {
    return this.answered(() =>
      this.req<WriteAnswer>("PATCH", `/interchange/collections/${collection}/members/${object}`, change),
    );
  }

  /**
   * Put something on a board, where it belongs, in one write.
   *
   * Creates and never edits: asking again for a membership that is already there
   * answers `created: false` and changes nothing, which is what makes it safe
   * for the queue to replay after a lost answer.
   */
  async addMember(
    collection: string,
    object: string,
    at: { region?: string | null; context?: Record<string, unknown> } = {},
  ): Promise<WriteAnswer> {
    return this.answered(() =>
      this.req<WriteAnswer>("PUT", `/interchange/collections/${collection}/members/${object}`, at),
    );
  }

  /**
   * Take something off a board.
   *
   * The membership, not the object. Removing one that is not there is a success,
   * so a replay that cannot tell whether its last write landed is safe to make
   * again.
   */
  async removeMember(collection: string, object: string): Promise<WriteAnswer> {
    return this.answered(() =>
      this.req<WriteAnswer>("DELETE", `/interchange/collections/${collection}/members/${object}`),
    );
  }

  /**
   * A collection's own keys — a canvas's sticky notes and the lines drawn
   * between them, and nothing else on this surface can write them.
   *
   * Prefixed, always. An unprefixed name belongs to the format and the producer
   * refuses it, which is right: the two `canvas_notes` of two different tools
   * are not the same key, and the prefix is what says so.
   */
  async patchCollection(
    id: string,
    change: { set?: Record<string, unknown>; unset?: string[]; version?: number },
  ): Promise<WriteAnswer> {
    return this.answered(() =>
      this.req<WriteAnswer>("PATCH", `/interchange/collections/${id}`, change),
    );
  }

  /**
   * Find something by the words in it.
   *
   * An envelope like any other read, holding what matched, most relevant first
   * — the producer's own ranking, and no scores, because a relevance number from
   * one producer means nothing beside another's.
   *
   * A producer that cannot search refuses rather than answering unfiltered, so
   * an empty result here means nothing matched and never "this instance ignored
   * the question and sent everything".
   */
  search(text: string): Promise<Record<string, unknown>> {
    return this.req<Record<string, unknown>>(
      "GET",
      `/interchange?q=${encodeURIComponent(text)}`,
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
   * `set` what should hold these values, `unset` what should hold none, and
   * `addTags`/`removeTags` for the vocabulary that is not a property at all. A
   * property or tag named by none of them is untouched, including every one
   * Talaria has never heard of — which is most of them, and the reason a person
   * can run this against a library it does not fully model.
   *
   * The tag half used to be `GET` then `PUT /blocks/:id/tags`, two round trips
   * against private routes, doing a read-modify-write that every client wanting
   * to add a tag would have had to repeat. It is one named move now.
   */
  async patch(
    id: string,
    change: {
      set?: Record<string, unknown>;
      unset?: string[];
      addTags?: string[];
      removeTags?: string[];
      version: number;
    },
  ): Promise<WriteAnswer> {
    return this.answered(() => this.req<WriteAnswer>("PATCH", `/interchange/objects/${id}`, change));
  }
}
