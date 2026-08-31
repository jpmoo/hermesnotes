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
  /** Which side has to move: the format, or Hermes. */
  owner: "format" | "hermes";
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
