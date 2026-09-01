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
- `requires` — the profiles or features this case is about, as
  `{ "features": ["series"] }`. An implementation that did not declare them is
  not asked: a kanban with no recurrence should be measured on boards and told
  nothing about repeating tasks. Settable on a whole suite. It does **not** cover
  the rules of the road — round-trip, valid envelopes, partial writes that do not
  destroy are obligations of the level rather than features to opt into.
- `simulated` — the expected answer depends on the consumer *lacking* something.
  A real tool that has the thing cannot answer, so the case is skipped as not
  applicable rather than failed. Only for cases where the lack drives the
  expectation; a `with` that merely describes a kind of tool is not enough.
- `roles` — which of `produce`, `consume`, `operate` this case is evidence
  about. Defaulted from the op and rarely worth setting: `validate` and
  `roundtrip` count for both producing and consuming, the reading ops for
  consuming, `patch` and `follow` for operating.
- `level` — the interoperability rung the case belongs to (see `AGENTS.md`).

## Operations

An implementation is testable when it can answer these sixteen. They are the whole
adapter surface; a producer that only writes files implements the first two and
declares the rest unsupported, and the last five are only asked of something with
a live binding.

| op | given | answers |
|---|---|---|
| `validate` | `export` (or a fragment) | `{ valid, errors: [{ code, path }] }` |
| `profilesOf` | `type` | the v0 profile names it declares |
| `read` | `type`, `object`, `args.key` | one profile value — `title`, `due`, `status` |
| `isComplete` | `type`, `object` | boolean |
| `order` | `collection`, `objects`, `types` | member ids in order, or `{ groups }` when it groups |
| `outline` | `objects` | roots in order, each `{ id, children }`, nested |
| `journal` | `types`, `objects`, `args.date` | the id of that day's page, or null |
| `nextOccurrence` | `series`, `instance`, `when` | `{ start?, due? }` or `null` |
| `import` | `export`, `with` | `{ result, fidelity, reports }` |
| `roundtrip` | `export`, `with` | import, then serialize, then compare |
| `create` | `object`, `existing?`, `args.at?` | `{ ok, created, object, fidelity, reports }` |
| `patch` | `object`, `patch`, `with` | `{ ok, conflict?, object, fidelity, reports }` |
| `place` | `collection`, `member`, `patch` | `{ ok, conflict?, member, fidelity, reports }` |
| `member` | `collection`, `args.object`, `args.op`, `patch?` | `{ ok, created?, removed?, member?, reports }` |
| `collectionPatch` | `collection`, `patch` | `{ ok, conflict?, collection, fidelity, reports }` |
| `collectionCreate` | `collection`, `existing?`, `args.at?` | `{ ok, created, collection, fidelity, reports }` |
| `follow` | `feed` | `{ alive, gone }` — what a follower concludes |

`fidelity` is `"full"` or `"reduced"`. `reports` name what was lost; a `reduced`
with an empty `reports` is a failed case, because an unexplained warning trains
people to ignore warnings.

`order` answers in one of two shapes, and which one is not a choice: ids in
order when the collection names no `groupBy`, and
`{ groups: [{ key, members }] }` when it does. They are one question — a
consumer wants the buckets and the order inside them together — so they are one
op rather than two that a caller has to reconcile.

`patch` matches its expected property bag **exactly** rather than as a subset. A
patch that leaves a property behind is the whole subject of that suite, and a
loose match would not see it. `create` matches the same way and for the same
reason — a property that did not survive being created is invisible to a subset
match, and there is no earlier version to notice it against.

`create` is given `existing` when the case is about a repeat: the object already
at that id, or absent when the id is free. `args.at` overrides the address, and
is only used by the case where the address and the body disagree about which id
is meant.

The three collection writes are all handed the **whole collection**, because
every rule they enforce is the collection's: which regions exist, whether
placement is a judgment or furniture, which members are already there. A member
handed over on its own cannot answer any of them.

`collectionCreate` matches its properties bag exactly too, and for a sharper
reason than the others: a create has no earlier version to be compared against,
so a key that did not survive being created is invisible for good.

`place` and `collectionPatch` match their bags **exactly**, for the reason
`patch` does: what these suites are about is a key quietly not surviving a write,
and a subset match is blind to one that went missing. `context: null` in an
expectation means *no bag at all* — JSON has no undefined, and an empty object is
a different answer that a round-trip would then be obliged to preserve.
`collectionPatch` cases may name `expect.keys`, which is the complete set of keys
the collection should have afterwards.

`member` takes `args.op`, which is `"put"` or `"delete"`. There is no separate op
for the two verbs because they are one question — does this membership exist —
and an implementation that answered them from different code would be the first
place a `PUT` quietly started editing.

Search has no op, deliberately. `?q=` is specified in `AGENTS.md`, but what a
fixture could assert about it is either trivial (a producer returns an envelope)
or wrong (that these three objects rank in this order), and the format explicitly
declines to standardise ranking. The rule that *is* worth enforcing — a producer
that cannot search must refuse rather than answer unfiltered — is a property of a
live binding and is checked there, by `pkm-check --url`, not here.

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
| `sorting: false` | shows a list in its stored order and cannot derive one |
| `grouping: false` | no grouped views — a flat list is all it draws |
| `hierarchy: false` | no containment — an outline arrives as a flat list |

The pair `placement/semantic-must-survive` and `placement/view-may-be-dropped`
run with **identical** capabilities and expect opposite fidelity. That is the
point of both cases: the difference is in what the producer declared, not in what
the consumer can do.

## Error codes

`validate` reports codes, not prose, so a case can assert which rule fired
without matching an error message. A write reports the same way, in `reports`
rather than `errors` — the vocabularies overlap where the rule is the same one
(`placement.coordinates-not-semantic` is enforced on a document and on a write),
and the write-only names are `placement.region-not-declared`,
`collection.unprefixed-write` and `tags.added-and-removed`.

| code | rule |
|---|---|
| `envelope.format` | `format` present but not `pkm-interchange/<n>` |
| `value.cardinality` | a `many` field holding a scalar, or a single field holding a list |
| `profile.field-not-declared` | a v0 profile mapping onto a field its type hasn't got |
| `inline.field-not-declared` | an inline edge names a field its type hasn't got |
| `relation.no-target` | an edge with no `to` |
| `stub.suggests-not-a-profile` | a stub's `suggests` naming a type id rather than a profile |
| `placement.coordinates-not-semantic` | semantic placement must name regions |
| `collection.unprefixed-write` | a collection write naming a key in the format's namespace |
| `order.by-invalid` | a sort or grouping key naming neither a field nor a known `meta` |
| `order.direction-invalid` | a direction that is not `ascending` or `descending` |
| `hierarchy.cycle` | an object that is its own ancestor |
| `collection.member-not-carried` | a collection answered alone, naming members it did not send |
| `series.completion-horizon` | `horizon` must be 1 when `anchor` is `completion` |
| `series.completion-byweekday` | `byWeekday` is meaningless with `anchor: completion` |
| `series.month-end-required` | monthly and yearly rules must declare `monthEnd` |
| `series.month-day-required` | a monthly or yearly rule with no `byMonthDay` |
| `changes.child-op` | a child row's own operation reported as the object's |
| `conformance.missing-roles` | a level claimed without saying for which role |
| `conformance.binding-required` | `operate` claimed with no live binding |
| `conformance.undeclared-feature` | the data uses a feature the manifest omits |
