/** The rows this mapping needs, as Hermes stores them. */
export interface HermesType {
  id: string;
  name: string;
  isText: boolean;
  propertySchema: import("@hermes/shared").PropertySchema | null;
  /** Lucide name. Decoration, and absent on a type nobody gave one. */
  iconKey?: string | null;
}

export interface HermesBlock {
  id: string;
  blockTypeId: string | null;
  collectionKind: string | null;
  content: string | null;
  properties: Record<string, unknown>;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Hermes' optimistic-concurrency counter. Travels so a reader can write back. */
  version?: number;
  tags?: string[];
  /** The series this block is an occurrence of, if it is one. */
  seriesId?: string | null;
}

export interface HermesMembership {
  collectionId: string;
  blockId: string;
  position: string | null;
  context: Record<string, unknown>;
  /** Optional so a caller that has no row version — an import building
   *  memberships from an envelope — is not made to invent one. */
  version?: number;
}

/**
 * Something Hermes holds that the format cannot say.
 *
 * Not an error and not a warning — a list of places where the two models do not
 * meet, which is the entire reason for building an exporter before rewiring
 * anything. `count` is how many rows hit it, because "one canvas does this" and
 * "every task does this" are different sizes of problem.
 */
export interface Finding {
  code: string;
  detail: string;
  count: number;
  /**
   * Which side has to move: the format, Hermes, or whoever sent this.
   *
   * `producer` is for a document that is simply wrong — bytes that do not hash
   * to the digest printed beside them, and nothing else so far. It is neither a
   * gap in the format nor a bug here, and filing it under either would put a
   * fault in somebody's list who cannot fix it.
   */
  owner: "format" | "hermes" | "producer";
}

/**
 * One file on a block, as the `attachments` table holds it.
 *
 * `data` is optional here and that is the whole of the size question: an
 * exporter decides per file whether it can afford to carry the bytes, and a
 * value with a hash and no bytes still tells a consumer exactly which file it
 * is not being given. See *Attachments* in the specification.
 */
export interface HermesAttachment {
  id: string;
  blockId: string;
  filename: string;
  mime: string;
  size: number;
  /** Raw bytes. Left out when the exporter chose not to carry this one. */
  data?: Uint8Array;
}

/** A recurrence rule, once, as the series table holds it. */
export interface HermesSeries {
  id: string;
  rule: Record<string, unknown>;
}

/** Change-log rows behind a `?since=` answer, before they become `changes`. */
export interface Delta {
  rows: { blockId: string; op: string; seq: number }[];
}
