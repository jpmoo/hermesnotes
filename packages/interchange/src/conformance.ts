/**
 * What Hermes claims, in one place, so it can be checked rather than believed.
 *
 * The levels are not hand-set: `pnpm measure` runs the fixtures against the real
 * functions and exits non-zero if anything here exceeds what it found. A
 * manifest a producer writes is a promise; one a suite has to agree with is
 * evidence.
 *
 * Each number is checked against the cases that are evidence about that role,
 * not against one number copied three times — a tool that writes a good file and
 * cannot read one has earned exactly one of these, and should not be able to say
 * otherwise. Two more scripts measure the ends directly: `pnpm probe` exports a
 * real library for `pkm-check` to validate, and `pnpm foreign` takes a
 * stranger's library out and back and counts what failed to return.
 */
export const CONFORMANCE = {
  format: "pkm-interchange/0",
  produce: 4,
  consume: 4,
  operate: 4,
  /**
   * `mcp` is claimed on the strength of four tools, not forty.
   *
   * Everything else on that surface is a Hermes convenience phrased in Hermes'
   * own words, and those are good tools that are not a binding. A binding is the
   * claim that the shared vocabulary travels over the transport — so a caller
   * who knows only the vocabulary can ask what this instance honours, read the
   * types in profile terms, read an object, and write part of one. Four tools do
   * that. Retrofitting the other forty would be a nicety.
   */
  bindings: ["file", "http", "mcp"],
  profiles: ["task", "note"],
  // `addresses` was missing while `url` was being emitted on every object and
  // every collection, which is under-claiming — and under-claiming measures the
  // same as not implementing it: `fixtures/address.json` requires the feature,
  // so all five of its cases were scoped away as not-applicable and had never
  // once run. A manifest is a promise in both directions.
  features: ["series", "placement", "derivations", "relations", "attachments", "addresses", "ordering"],
  /**
   * What this producer does not do, said out loud.
   *
   * `hierarchy` is here because Hermes is flat: blocks and collections, with a
   * rollup built from reference fields rather than stored containment. It can
   * carry somebody else's outline — the round-trip rule sees to that, and the
   * stranger's library round-trips 234 leaves with none lost — and it cannot
   * draw one, which is a different claim and has to be a different word.
   *
   * Worth knowing that a feature in this list is scoped away when the suite
   * measures this producer, so the hierarchy cases run against the reference
   * and not against Hermes. That is correct and it is also the exact shape of
   * the `addresses` mistake, where a feature was omitted from `features` while
   * being emitted — so: absent from `features` means "not in this data", and
   * present in `unsupported` means "this software cannot".
   */
  unsupported: ["hierarchy"] as string[],
} as const;
