/**
 * A partial write.
 *
 * Two moves and no third. A property named by neither `set` nor `unset` is left
 * exactly as it was — including every property this build has never heard of.
 *
 * The failure this exists to stop is quiet and common: a client sends the two
 * fields it cares about, the server treats the payload as the whole object, and
 * everything else is gone. It is not hypothetical here. `PATCH /blocks/:id`
 * replaced the property bag wholesale, and the only reason nothing had been lost
 * is that every caller in this codebase happened to read the block first and
 * send it all back. The first integration that did not would have been the last
 * time that data existed.
 */

export interface PropertyPatch {
  /** Properties to write. Everything not named here is untouched. */
  set?: Record<string, unknown>;
  /** Properties to remove. The only way to remove one. */
  unset?: string[];
  /** The version this patch was written against, when the caller knows it. */
  version?: number;
}

export interface PatchOutcome {
  ok: boolean;
  /** The patch was written against a version that has since moved. */
  conflict?: boolean;
  properties: Record<string, unknown>;
  fidelity: "full" | "reduced";
  /** What could not be kept. Empty when `fidelity` is "full", which is a promise. */
  reports: string[];
}

export function applyPatch(
  current: { properties: Record<string, unknown>; version?: number },
  patch: PropertyPatch,
): PatchOutcome {
  // Versioned and stale: refuse. Merging looks helpful and is how one client's
  // edit silently reverts another's, with the writer told it landed.
  if (patch.version !== undefined && current.version !== undefined && patch.version !== current.version) {
    return { ok: false, conflict: true, properties: current.properties, fidelity: "full", reports: [] };
  }

  const next = { ...current.properties };
  for (const [k, v] of Object.entries(patch.set ?? {})) next[k] = v;
  // `null` is a value in plenty of models, and an absent key is the case above.
  // One explicit list, and no ambiguity left over.
  for (const k of patch.unset ?? []) delete next[k];

  // Hermes stores properties as an open bag, so there is nothing it can be
  // handed that it cannot keep. Saying "full" is a promise, and it is worth
  // something only because it is not said defensively.
  return { ok: true, properties: next, fidelity: "full", reports: [] };
}
