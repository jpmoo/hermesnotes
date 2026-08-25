/**
 * A region's name and the words a person reads are two different things.
 *
 * The name is derived from the label by slugging, which is lossy in exactly the
 * case that matters: "Delegate & Wait" becomes `delegate-wait` and there is no
 * way back. A real board arrived in Talaria with four regions called "Region 1"
 * through "Region 4" — matched correctly against the members, and rendered as
 * nothing anybody had written.
 *
 * Its own script rather than a line in `narrowcheck`, because it needs no
 * library: it is a fact about one function, and the checks that read a library
 * cannot run here any more.
 */
import { regionNamesOf, regionsOf } from "./src/map.js";

let bad = 0;
const check = (n: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${n}${d ? `   ${d}` : ""}`);
  if (!ok) bad += 1;
};

const props = {
  // "do" is already its own name; "Do" is not — a capital is something somebody
  // typed, and the bare-string form is only right when there is genuinely
  // nothing the name loses.
  matrix_regions: [
    { title: "do" },
    { title: "Delegate & Wait", color: "#5fa4b5" },
    { title: "" },
    { title: "Defer", color: null },
  ],
};
const r = regionsOf(props);
console.log(`  ${JSON.stringify(r)}\n`);

check("a title that is already its own name stays a bare string", r[0] === "do");
check(
  "a capital is not nothing",
  typeof regionsOf({ matrix_regions: [{ title: "Do" }] })[0] === "object",
);
check(
  "one that does not carries both",
  typeof r[1] === "object" &&
    (r[1] as { name: string }).name === "delegate-wait" &&
    (r[1] as { label: string }).label === "Delegate & Wait",
);
check("an untitled region still gets a stable name", r[2] === "region-2");
check(
  "the names are unchanged by any of it",
  JSON.stringify(regionNamesOf(props)) === JSON.stringify(["do", "delegate-wait", "region-2", "defer"]),
);
check(
  "a colour rides along under the producer's own prefix",
  (r[1] as Record<string, unknown>)["hermes:color"] === "#5fa4b5",
);
check(
  "a colour on a region that would otherwise be a bare string still forces the object form",
  typeof regionsOf({ matrix_regions: [{ title: "do", color: "#fff" }] })[0] === "object",
);
check("a null colour is not a colour", (r[3] as Record<string, unknown>)["hermes:color"] === undefined);
check("a board with no regions invents none", regionsOf({}).length === 0);

console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
