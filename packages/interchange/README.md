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
