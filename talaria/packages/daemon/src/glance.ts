import type { Mirror } from "./mirror.js";

/**
 * What the library knows about what you are looking at.
 *
 * Glance embeds the front window's own words on this machine, compares that
 * vector against the mirror, and returns what is near it. The comparison is
 * arithmetic over a few hundred vectors, which is nothing — the whole cost is
 * the one embedding call, and it is local.
 *
 * Three properties, and the first two are the reason it is built this way round.
 *
 * - **The words never leave.** A window title is the most revealing telemetry on
 *   a Mac. Embedding happens here, against a model on this machine, and only the
 *   vector is ever a candidate for going anywhere. That is a large reduction and
 *   not a guarantee: an embedding can be partially inverted, so this is "much
 *   harder to read" rather than "anonymous", and it should never be described as
 *   the latter.
 *
 * - **It works away from home.** Hermes indexes against an Ollama on the LAN,
 *   which a laptop in a café cannot reach. Glance keeps its own index, so the
 *   feature does not evaporate the moment you leave the house — which is
 *   precisely when a memory aid is worth having.
 *
 * - **A vector without its model is not a weak signal, it is a wrong one.**
 *   Cosine similarity between embeddings of two different models returns a
 *   plausible number rather than an error, so every stored vector records the
 *   model that made it and a change of model throws the index away. This is the
 *   same rule the format applies to a region name and to a cursor: a value whose
 *   meaning depends on a context must carry the context.
 */

/** Where the words come from and how much of them are worth embedding. */
export const MAX_SOURCE = 512;

/**
 * The title policy that applies to Glance, which is not the one that applies to
 * the record.
 *
 * `TITLE_TRUSTED` is a short allowlist because a title that gets *stored* sits
 * in a rolling record for eight hours, and a window-title stream is the most
 * revealing telemetry on a Mac. That is a rule about keeping.
 *
 * Glance keeps nothing. It reads the title, turns it into 768 floats on this
 * machine, and drops the string on the same tick — so the risk the allowlist was
 * written against does not arise, and applying it here would mean the feature
 * answering "nothing in front worth asking about" in front of almost every
 * application a person actually works in. It did, on the first run.
 *
 * What still applies is `TITLE_BLIND`: a password manager's window title should
 * not be read at all, by anybody, for any purpose, however briefly. That is a
 * rule about looking, and looking is what Glance does.
 */
export function mayEmbedTitle(app: string, blind: readonly string[]): boolean {
  return !blind.includes(app);
}

export interface GlanceHit {
  id: string;
  score: number;
}

export interface Embedder {
  model: string;
  embed(text: string): Promise<Float32Array>;
}

/**
 * Ollama, on this machine by default.
 *
 * The URL is a setting rather than a constant because "local" is the intent, not
 * the mechanism — somebody running a shared box on a trusted LAN is entitled to
 * that trade as long as they are the one making it.
 */
export function ollamaEmbedder(url: string, model: string): Embedder {
  return {
    model,
    async embed(text: string): Promise<Float32Array> {
      const res = await fetch(`${url.replace(/\/$/, "")}/api/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, prompt: text.slice(0, MAX_SOURCE) }),
      });
      if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as { embedding?: number[] };
      if (!body.embedding?.length) throw new Error("ollama returned no embedding");
      return Float32Array.from(body.embedding);
    },
  };
}

/**
 * Cosine similarity.
 *
 * Not normalised in advance, because these vectors arrive from a model that does
 * not promise unit length and a wrong assumption there is invisible: every score
 * would be off by a constant factor per pair, which still sorts *almost* right.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

export class Glance {
  constructor(
    private mirror: Mirror,
    private embedder: Embedder,
  ) {}

  /**
   * Bring the index up to date, a slice at a time.
   *
   * Only what changed: the source text is stored beside its vector, so a block
   * nobody edited is never re-embedded. Called on a timer rather than on every
   * sync, because a full library is a few hundred model calls and there is no
   * hurry — a Glance that is one block stale is not wrong, it is behind.
   */
  async index(limit = 50): Promise<{ embedded: number; left: number }> {
    const todo = this.mirror.unembedded(this.embedder.model, limit);
    let embedded = 0;
    for (const row of todo) {
      try {
        const vec = await this.embedder.embed(row.source);
        this.mirror.putEmbedding(row.id, this.embedder.model, vec, row.source);
        embedded += 1;
      } catch {
        // One failure is not a reason to abandon the batch, and the row simply
        // stays unembedded for the next pass.
        break;
      }
    }
    const left = this.mirror.unembedded(this.embedder.model, 1).length;
    return { embedded, left };
  }

  /** What in the library is nearest to this text. */
  async similar(text: string, k = 8): Promise<GlanceHit[]> {
    const trimmed = text.trim();
    if (!trimmed) return [];
    const q = await this.embedder.embed(trimmed);
    return this.nearest(q, k);
  }

  /** The same, given a vector somebody else produced with the same model. */
  nearest(q: Float32Array, k = 8): GlanceHit[] {
    const scored: GlanceHit[] = [];
    for (const row of this.mirror.embeddings(this.embedder.model)) {
      const score = cosine(q, row.vec);
      if (score > 0) scored.push({ id: row.id, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  /**
   * Throw the index away when the model changes.
   *
   * Returns how many were forgotten, because silently rebuilding a few hundred
   * vectors is the kind of work a person should be told about.
   */
  reconcileModel(): number {
    const stale = this.mirror.embeddingStats().filter((s) => s.model !== this.embedder.model);
    if (!stale.length) return 0;
    return this.mirror.forgetEmbeddings();
  }
}
