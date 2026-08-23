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

**Hermes earns level 0.** 16 of 64.

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
