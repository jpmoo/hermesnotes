# @hermes/interchange

Hermes as a pkm-interchange producer. Pure: rows in, envelope out, plus a list
of everything the format could not be told.

```bash
pnpm --filter @hermes/interchange probe /tmp/hermes-export.json
node pkm-interchange/check/src/cli.js /tmp/hermes-export.json
```

`probe.ts` reads Talaria's local mirror rather than the server — same rows, no
deploy, and the point of running it is to find out what the format cannot say
about a real account *before* anything is rewired around it. There is no
endpoint yet, on purpose: an export is read-only and cannot break anything,
which is what makes it the right instrument to measure with.

## The findings are the product

An exporter that silently drops what it cannot express produces a clean-looking
file and teaches nobody anything — the failure the format spends most of its
rules preventing. This one keeps a tally instead, and each finding says which
side has to move.

Run against a real library of 108 objects, 6 types and 8 collections. The first
run found nine; the format has since answered four of them and the list now
reads:

| finding | owner | ×  |
|---|---|---|
| `series.no-identity` | hermes | 12 |
| `datespan.empty-string-end` | hermes | 6 |
| `profile.derived-not-declared` | hermes | 2 |
| `placement.semantic-is-per-region` | format | 1 |
| `canvas.stickies-are-not-addressable` | format | 1 |
| `attachments.contents-do-not-travel` | format | 1 |

The counts matter as much as the list: "one canvas does this" and "every task
does this" are different sizes of problem — which is why cardinality, at 62,
was the first thing fixed and the canvas, at 1, is a written-down limit instead.

The three still owned by the format are in `AGENTS.md` under **Known limits of
v0**. The three owned by Hermes are real work: series identity is a schema
change, the empty strings are a write-path habit, and the undeclared profiles
just need somebody to open the type editor.

## Measuring Hermes, rather than claiming for it

```bash
pnpm --filter @hermes/interchange measure
```

`adapter.ts` wires the fixtures onto the real functions — the same `isComplete`,
`readProfile` and `nextSpan` the server and the web app call. An adapter that
reimplements the rules on the way to the suite is testing the adapter, so this
one calls through and leaves off every operation Hermes has no answer for.
Missing counts as failing, and it should: to somebody deciding whether to trust
their notes to a tool, "we have not built that" and "we built it wrong" are the
same news.

**The first run: Hermes earned level 0.** 16 of 64.

Everything below this line is what happened next, and the number at the bottom of
this file is where it stands now. Both are kept deliberately — a document that
only ever shows the current score is one you cannot tell a real measurement from
a claim in.

Most of that is absence — no consumer, no validator, no patch semantics, so 48
cases fail with nothing to call. The interesting number is the other one: of the
17 cases Hermes can answer, it fails 2, both of them recurrence.

| case | Hermes says | should be |
|---|---|---|
| `recurrence/monthly-31st-skip` | `2026-02-28` | `2026-03-31` |
| `recurrence/monthly-clamp-does-not-reanchor` | `2026-03-28` | `2026-03-31` |

Hermes has no `monthEnd`: it always clamps, and then advances from the clamped
date, so a task due on the 31st becomes a task due on the 28th permanently after
one February. Neither is fixable without somewhere to record the day the series
was anchored to — the format has the same hole, recorded in
`fixtures/README.md` — so this is one change on both sides rather than a bug fix
on one.

Three others were fixed by reading the vocabulary Hermes had already declared:
`isComplete` now goes through the task profile, `readProfile` treats an empty
string as absent, and a profile can name `content` as the body.

One caveat the run exposed about the fixtures themselves:
`profile/unknown-name-is-readable` passes here for the wrong reason. It expects
`false`, and an implementation that always answers `false` passes it. A case
whose expectation is a default is not a test.

## Reading, not just writing

```bash
pnpm --filter @hermes/interchange roundtrip   # Hermes' own library, out and back
pnpm --filter @hermes/interchange foreign     # a stranger's library, out and back
```

`fromInterchange` is the harder direction. Exporting only has to find a way to
say what you hold; importing has to find somewhere to put what you don't.
Anything with no Hermes column rides along in the property bag under
`pkm:carried` and comes back out as the keys it arrived as — series definitions
and relations are handed back separately, because Hermes has no table for either
and pretending otherwise would round-trip cleanly right up until somebody
checked.

Two results, both measured:

- **Hermes' own library**: 3495 lines out, 3495 back, **0 differing**.
- **A stranger's library** (`example/library.json`, with series, profiles Hermes
  has never seen, and properties no Hermes type declares): 205 leaves in,
  **0 did not come back**.

The second is the one that means anything. The first is nearly free — an
exporter and an importer written together are inverses by construction.

Both surfaced real bugs. Unknown keys hung on a *field* were being dropped,
because a mapping table that names nine keys loses the tenth by omission. And a
member arrived as a bare id and left as an object, which turned out to be an
ambiguity in the format rather than a bug in the code: two spellings for one
member, now written down as shorthand with expansion declared not to be a loss.

**Hermes earns level 4.** 69 of 83, with 14 cases not applicable.

```
level 1: 25 passed, 0 failed
level 2: 24 passed, 0 failed, 10 not applicable
level 3:  1 passed, 0 failed, 3 not applicable
level 4: 19 passed, 0 failed, 1 not applicable
```

`src/conformance.ts` holds the claim and `pnpm measure` refuses to pass if the
claim exceeds what the suite found. `GET /api/conformance` serves it, so a client
can ask before it writes rather than discovering by trying.
