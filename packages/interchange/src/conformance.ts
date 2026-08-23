/**
 * What Hermes claims, in one place, so it can be checked rather than believed.
 *
 * The levels are not hand-set: `pnpm measure` runs the fixtures against the real
 * functions and exits non-zero if anything here exceeds what it found. A
 * manifest a producer writes is a promise; one a suite has to agree with is
 * evidence.
 *
 * One caveat worth stating rather than hiding. The suite does not yet partition
 * its cases by role, so it earns **one** level and all three numbers below are
 * checked against it. The separate evidence for the first two is elsewhere and
 * is run the same way: `pnpm probe` exports a real library and `pkm-check`
 * validates it, and `pnpm foreign` takes a stranger's library out and back and
 * counts what failed to return. Until the suite splits by role, those two
 * scripts are the reason `produce` and `consume` are not merely copies of a
 * number earned somewhere else.
 */
export const CONFORMANCE = {
  format: "pkm-interchange/0",
  produce: 4,
  consume: 4,
  operate: 4,
  /**
   * `mcp` is deliberately absent. The MCP tools are safe — they read a block and
   * merge, so an agent that sets one field does not destroy the others — but
   * safe is not the same as speaking this vocabulary. They know nothing of
   * profiles and report no fidelity, and a binding is a claim that the model
   * travels over that transport, not that the transport is well behaved.
   */
  bindings: ["file", "http"],
  profiles: ["task", "note"],
  features: ["series", "placement", "derivations", "relations", "attachments"],
  unsupported: [] as string[],
} as const;
