/**
 * What leaves, when a caller asked for less than everything.
 *
 * `?profile=` and `?since=` are the two narrowings v0 defines, and both are
 * refinements of one document rather than shapes of their own — a narrowed read
 * is still an envelope, which is the whole reason a client can know what it is
 * getting before it asks.
 *
 * Lives here rather than in the route because it is format logic, not transport:
 * the same reduction applies to a file somebody asked to be trimmed and to an
 * MCP tool answering a scoped read.
 */
import type { Delta } from "./types.js";

/**
 * The whole library, reduced to what was asked for.
 *
 * Narrowing happens after the export rather than before it because the exporter
 * derives relations and resolves inline mentions across the *whole* set — run it
 * on a subset and a mention whose target was filtered out becomes a stub with a
 * fresh id, which is id churn dressed up as a delta. So: build the true
 * envelope, then decide what leaves.
 *
 * Types always travel whole. There are a handful of them, an object without its
 * type cannot be read at all, and the format makes that a rule rather than a
 * courtesy.
 */
export function narrow(
  envelope: Record<string, unknown>,
  delta: Delta | null,
  profile: string | undefined,
): Record<string, unknown> {
  const out = { ...envelope };
  const types = (out.types ?? []) as { id: string; profiles?: Record<string, unknown> }[];
  let objects = (out.objects ?? []) as { id: string; type?: string }[];

  if (profile) {
    const declaring = new Set(types.filter((t) => t.profiles?.[profile]).map((t) => t.id));
    objects = objects.filter((o) => o.type && declaring.has(o.type));
  }

  if (delta) {
    // Last row wins, in both directions: an object deleted and recreated is
    // present, and one created and deleted is gone.
    const op = new Map<string, string>();
    for (const r of [...delta.rows].sort((a, b) => a.seq - b.seq)) op.set(r.blockId, r.op);
    const gone = new Set([...op].filter(([, v]) => v === "delete").map(([k]) => k));
    const touched = new Set(op.keys());
    objects = objects.filter((o) => touched.has(o.id) && !gone.has(o.id));
    out.changes = [...op]
      .map(([object, o]) => ({ object, op: o === "insert" ? "create" : o }))
      .sort((a, b) => (a.object < b.object ? -1 : 1));

    // Collections arrive whole rather than as a delta of their own. A card
    // moving is reported as an update to the card, and where it landed lives on
    // the collection — so a follower that got the update and not the board
    // would know something moved and not where to.
    const live = new Set(objects.map((o) => o.id));
    out.collections = ((out.collections ?? []) as { members?: { object?: string }[] }[]).filter((c) =>
      (c.members ?? []).some((m) => m.object && live.has(m.object)),
    );
  }

  out.objects = objects;
  return out;
}
