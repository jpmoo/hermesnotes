# pkm-check — the runner

Implementation notes. For what the format is and how to make an app speak it,
read [../README.md](../README.md); for the specification itself,
[../AGENTS.md](../AGENTS.md).

## How an implementation plugs in

Export the ten operations in [`../fixtures/README.md`](../fixtures/README.md)
and hand the object to `runSuites`:

```js
import { runSuites, levelsFrom } from "./src/runner.js";
const results = runSuites(myAdapter, "../fixtures");
console.log(levelsFrom(results));   // { earned: 2, byLevel: {...} }
```

`src/reference.js` is a working adapter to copy. The interesting part of it is
that it never takes a document apart: it holds the original and overlays its own
model, which is what keeps unknown fields, their order and their nesting intact
on the way back out. An implementation that decomposes into its own fields and
reassembles will lose things and pass its own tests while doing it.

## `mutants.js`

A fixture suite that has never gone red has told you nothing. Each mutant is a
plausible wrong implementation — clamping recurrence that re-anchors, an
importer that drops the regions it cannot draw, a consumer that renumbers ids —
paired with the case that has to catch it.

It has already earned its place: `placement/position-is-opaque` passed under a
locale-aware sort, because its data was `a0 / a0V / a1`, which orders the same
either way. Its own `why` names the pair that breaks — `Zz` against `a0` — and
the fixture didn't contain it. It does now.

## Levels

`levelsFrom` reports the highest rung with no failures beneath it. The point is
that it is derived from a run: a manifest a producer writes is a promise, one
that falls out of the suite is evidence.
