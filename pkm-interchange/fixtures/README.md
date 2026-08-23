# The fixture grammar

The fixtures are authoritative, which means they have to be executable. This
file is the contract between them and whatever runs them.

Nothing here changes what the suites *say*. Every `why` is the original text, and
the cases test what they always tested. What changed is that a scenario like
"a tool with no matrix view" is now capability **data** rather than English, so a
runner can act on it.

## A case

```json
{
  "id": "placement/semantic-must-survive",
  "level": 2,
  "op": "import",
  "given": { "collection": { ... } },
  "with": { "placement": false },
  "expect": { "fidelity": "reduced", "result": { ... } },
  "why": "..."
}
```

- `op` — which operation to run. The list is below and it is closed.
- `given` — the input. Whatever the op needs: a `type`, an `object`, a
  `collection`, a `series`, an `export`.
- `when` — an event, for ops that have one (`completed`, `thenCompleted`).
- `with` — the **capabilities** of the consumer being simulated.
- `expect` — matched as a **subset**. Keys absent from `expect` are not checked,
  so a case says only what it is about.
- `of` — which part of the result `expect.result` is about: `envelope`,
  `object` or `collection`. Inferred when absent, from what `given` holds. Say it
  outright whenever `given` holds more than one thing.
- `level` — the interoperability rung the case belongs to (see `AGENTS.md`).

## Operations

An implementation is testable when it can answer these ten. They are the whole
adapter surface; a producer that only writes files implements the first two and
declares the rest unsupported, and the last two are only asked of something with
a live binding.

| op | given | answers |
|---|---|---|
| `validate` | `export` (or a fragment) | `{ valid, errors: [{ code, path }] }` |
| `profilesOf` | `type` | the v0 profile names it declares |
| `read` | `type`, `object`, `args.key` | one profile value — `title`, `due`, `status` |
| `isComplete` | `type`, `object` | boolean |
| `order` | `members` | member ids in order |
| `nextOccurrence` | `series`, `instance`, `when` | `{ start?, due? }` or `null` |
| `import` | `export`, `with` | `{ result, fidelity, reports }` |
| `roundtrip` | `export`, `with` | import, then serialize, then compare |
| `patch` | `object`, `patch`, `with` | `{ ok, conflict?, object, fidelity, reports }` |
| `follow` | `feed` | `{ alive, gone }` — what a follower concludes |

`fidelity` is `"full"` or `"reduced"`. `reports` name what was lost; a `reduced`
with an empty `reports` is a failed case, because an unexplained warning trains
people to ignore warnings.

`patch` matches its expected property bag **exactly** rather than as a subset. A
patch that leaves a property behind is the whole subject of that suite, and a
loose match would not see it.

## Capabilities

`with` describes a consumer's limits. Absent means capable.

| key | meaning |
|---|---|
| `placement: false` | cannot render regions — no matrix, no board |
| `query: false` | no query engine |
| `relations: false` | untyped backlinks only |
| `archive: false` | no archived state |
| `attachments: false` | cannot hold files |
| `series: { anchors: [...] }` | recurrence, but only these anchors |
| `conditions: [...]` | query condition kinds it can evaluate |
| `profiles: [...]` | profiles it understands |
| `richtext: false` | cannot hold prose at all |
| `richtextRewrite: true` | normalises prose into its own markup on import |
| `fixedSchema: true` | maps into a fixed internal model — the hard case for unknown fields |
| `remapIds: true` | keys objects by its own ids internally |

The pair `placement/semantic-must-survive` and `placement/view-may-be-dropped`
run with **identical** capabilities and expect opposite fidelity. That is the
point of both cases: the difference is in what the producer declared, not in what
the consumer can do.

## Error codes

`validate` reports codes, not prose, so a case can assert which rule fired
without matching an error message.

| code | rule |
|---|---|
| `placement.coordinates-not-semantic` | semantic placement must name regions |
| `series.completion-horizon` | `horizon` must be 1 when `anchor` is `completion` |
| `series.completion-byweekday` | `byWeekday` is meaningless with `anchor: completion` |
| `series.month-end-required` | monthly and yearly rules must declare `monthEnd` |
| `conformance.undeclared-feature` | the data uses a feature the manifest omits |
| `inline.field-not-declared` | an inline edge names a field its type hasn't got |
| `relation.no-target` | an edge with neither `to` nor `label` |
| `relation.expects-not-a-profile` | `expects` naming a type id rather than a profile |
| `changes.child-op` | a child row's own operation reported as the object's |
| `conformance.missing-roles` | a level claimed without saying for which role |
| `conformance.binding-required` | `operate` claimed with no live binding |

## One thing the spec does not yet answer

`monthEnd: "clamp"` must not re-anchor: a monthly rule on the 31st that clamps to
28 February has to give 31 March next, not 28 March. That is only computable if
something remembers the 31, and nothing in the format does — the rule has no
`byMonthDay` and an instance carries only its own dates.

The runner reads it as **the series' first instance is the anchor**, which is the
only interpretation the existing data supports. The spec should say so outright,
or give the rule a `byMonthDay`. Recorded here rather than papered over, because
two implementers reading this today would disagree and both would pass their own
tests.
