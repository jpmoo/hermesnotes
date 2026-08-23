/**
 * What a follower concludes from a run of change-log rows.
 *
 * Two rules, and both were wrong here until recently.
 *
 * Rows arrive in order, so the **last** row about an object is the current one —
 * in both directions. Letting a delete outrank everything after it is defensible
 * right up until something legitimately comes back, and then the follower is
 * missing an object that exists with nothing to correct it short of reading
 * everything again.
 *
 * And `op` describes the object, never the row that moved in storage. A
 * membership or a tag going away is an update to the object that had it —
 * migration 0029, which exists because a card dragged between two matrix regions
 * is a membership deleted and re-inserted, and every open tab was being told the
 * block had gone.
 */

export interface ChangeRow {
  blockId: string;
  op: string;
  /** Which part moved, when the producer says: "object", "membership", "tag". */
  cause?: string;
}

export function foldChanges(rows: ChangeRow[]): { alive: string[]; gone: string[] } {
  const state = new Map<string, "alive" | "gone">();
  for (const r of rows) state.set(r.blockId, r.op === "delete" ? "gone" : "alive");
  return {
    alive: [...state].filter(([, v]) => v === "alive").map(([id]) => id),
    gone: [...state].filter(([, v]) => v === "gone").map(([id]) => id),
  };
}
