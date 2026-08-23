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

Run against a real library of 108 objects, 6 types and 8 collections, in
descending order of how often it bit:

| finding | owner | ×  |
|---|---|---|
| `reference.multi-valued` | format | 62 |
| `object.body-outside-properties` | format | 17 |
| `series.no-identity` | hermes | 12 |
| `datespan.empty-string-end` | format | 6 |
| `field.no-kind` | format | 1 |
| `profile.derived-not-declared` | hermes | 1 |
| `placement.semantic-is-per-region` | format | 1 |
| `canvas.stickies-are-not-objects` | format | 1 |
| `attachments.contents-do-not-travel` | format | 1 |

The counts matter as much as the list: "one canvas does this" and "every task
does this" are different sizes of problem.
