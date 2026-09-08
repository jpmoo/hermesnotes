/**
 * Hermes Notes, through pkm-interchange and nothing else.
 *
 * The standing rule for anything talking to Hermes from outside: reach it
 * through the format, and when the format cannot say something, say so and ask
 * rather than going around. Every call here is a documented interchange
 * endpoint — the manifest, the read, and the create — and the one thing this
 * plugin needs that v0 could not do (carrying a file) is a thing the format
 * does now.
 *
 * So there is no `/blocks`, no `/attachments`, no Hermes-shaped payload
 * anywhere in this plugin. A block is an object; a picture is an attachment
 * value on that object; a type is chosen by the profile it declares.
 */

export interface Field {
  key: string;
  kind?: string;
  label?: string;
  many?: boolean;
}

export interface HermesType {
  id: string;
  name: string;
  fields?: Field[];
  profiles?: Record<string, Record<string, unknown>>;
  hermesTextType?: boolean;
}

export interface Conformance {
  features?: string[];
  profiles?: string[];
}

export class HermesError extends Error {}

/** A v4 for an object we are about to create.
 *
 *  `crypto.randomUUID` is not in this JS engine, and the id only has to be
 *  unique among things this device makes — the producer refuses a collision
 *  rather than merging into it, because `PUT` at an id that exists answers
 *  `created: false` and changes nothing. */
export function uuid(): string {
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += "-";
    else if (i === 14) out += "4";
    else if (i === 19) out += hex[(Math.floor(Math.random() * 16) & 0x3) | 0x8];
    else out += hex[Math.floor(Math.random() * 16)];
  }
  return out;
}

export class Hermes {
  constructor(
    private base: string,
    private token: string,
  ) {
    // Everything is under `/api`, and somebody typing a base URL on a device
    // will type the site, not the mount. Accepting both spellings costs one
    // line here and saves a support conversation that would happen on a screen
    // with no keyboard.
    this.base = base.replace(/\/+$/, "").replace(/\/api$/, "");
  }

  private async ask<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      // A device that has wandered off the network is the ordinary case here,
      // not an exception — say which so the screen can say "no network" rather
      // than printing a stack trace at somebody holding a pen.
      throw new HermesError(`cannot reach Hermes at ${this.base}`);
    }
    const text = await res.text();
    if (!res.ok) {
      // The first line of whatever came back. A Fastify error is one line of
      // JSON; a proxy in the way is a page of HTML, and the first line of that
      // at least names the proxy.
      const first = text.split("\n")[0]?.slice(0, 200) ?? "";
      throw new HermesError(`${res.status} ${first}`);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  /**
   * What this instance honours — asked before anything is written.
   *
   * The point of a manifest is that a client learns what it is dealing with
   * without attempting a write to find out. This plugin needs one specific
   * thing, `attachment-bytes`, and a Hermes too old to carry files should be
   * told apart from a Hermes that is refusing.
   */
  conformance(): Promise<Conformance> {
    return this.ask<Conformance>("GET", "/api/conformance");
  }

  /**
   * Every type, with what each declares.
   *
   * There is no types-only read in the binding, so this is the ordinary one and
   * the types are taken off it. That means a whole library crosses the wire to
   * answer a question about a dozen rows — which is why the caller caches the
   * answer rather than asking per send. Attachment bytes are not in it: `files`
   * is off unless asked for, so this is text, and text is small.
   */
  async types(): Promise<HermesType[]> {
    const env = await this.ask<{ types?: HermesType[] }>("GET", "/api/interchange");
    return env.types ?? [];
  }

  /** Bring an object into being, at an id we chose. */
  create(
    id: string,
    object: { type: string; properties?: Record<string, unknown>; content?: string },
  ): Promise<{ ok?: boolean; created?: boolean; reports?: string[] }> {
    return this.ask("PUT", `/api/interchange/objects/${id}`, object);
  }
}

/**
 * Which types can stand for "a note" and "a task", by what they declare.
 *
 * **Never by name.** A type called `Task` is a row somebody can rename, and
 * matching on the string is the bug the library this talks to names in its own
 * invariants — it has cost one import of three hundred notes already. A task is
 * a type declaring the `task` profile, whatever it is called; a note is one
 * declaring `note`, or a text type, which is Hermes' own word for the same idea.
 */
export function offer(types: HermesType[]): { task: HermesType[]; note: HermesType[] } {
  const declares = (t: HermesType, p: string) => Boolean(t.profiles && t.profiles[p]);
  return {
    task: types.filter((t) => declares(t, "task")),
    note: types.filter((t) => declares(t, "note") || t.hermesTextType === true),
  };
}

/**
 * Where a title goes on this type.
 *
 * The profile says so — that is what a profile is for. A mapping may name the
 * field directly or as `{ field, part }` for a compound one, and `content` is
 * the reserved body slot rather than a property key.
 */
export function titleKey(type: HermesType, profile: string): string | null {
  const spec = type.profiles?.[profile]?.title;
  const named =
    typeof spec === "string" ? spec : typeof spec === "object" && spec !== null
      ? (spec as { field?: unknown }).field
      : undefined;
  if (typeof named !== "string" || named === "content") return null;
  return named;
}

/** Where a file goes on this type. By kind, for the same reason as above. */
export function attachmentKey(type: HermesType): string | null {
  return (type.fields ?? []).find((f) => f.kind === "attachment")?.key ?? null;
}
