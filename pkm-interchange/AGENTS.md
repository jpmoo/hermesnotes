# pkm-interchange/0

A wire format for moving personal-knowledge objects — notes, tasks, events, people, projects, whatever you invented — between tools that model them differently.

**Name is provisional.** So is everything else. This is version 0.

---

## If you are an agent implementing this

1. Read this file. It is self-contained; it references no other specification normatively.
2. Load `fixtures/*.json`. **The fixtures are authoritative.** Where this prose and a fixture disagree, the fixture is correct and the prose is a bug.
3. Read `example/library.json` — one complete, valid export. Pattern-match off it.
4. Run the fixtures against your implementation. Each has a `why`; when one fails, read it before patching, because it usually explains a rule that has untested neighbours.

---

## The two rules everything else follows from

**1. The data declares its own meaning.**

A consumer must never need to know what a producer's types are called. If a type is task-like, the type says so and says which of its fields carry the due date and the completion state. `if (type.name === "Task")` is always a bug — in your code and in this format.

**2. A view never smuggles in meaning.**

Where something sits on a canvas is not knowledge. Where something sits in an Eisenhower matrix is. The format makes producers say which, because a consumer cannot tell by looking.

Everything below is these two rules applied to a specific case.

---

## Levels

There are different ways to be interoperable and they are not the same
achievement. "My app makes something yours can open" is real and worth having;
it is also several rungs below "our two apps can work in unison with a harness
between them". Most of this genre says *interoperable* and means the first one,
which is why the word has stopped carrying information.

So it is a ladder, and each rung is a claim a checker can verify — and one you
can lose.

| | claim | what it takes | what it buys |
|---|---|---|---|
| **0 · Readable** | a valid export | envelope, types, objects | someone can open it and see it |
| **1 · Legible** | declared profiles | profiles on types; no name-guessing | a stranger's tool finds the due date without knowing your vocabulary |
| **2 · Faithful** | round-trip | unknown fields, ids, flags, relation types all survive | your app can be a **waypoint** rather than a terminus |
| **3 · Honest** | loud failure | fidelity reporting; manifest matches behaviour | a human can trust the transfer |
| **4 · Operable** | a live surface | patch semantics, capability discovery, a change feed | a harness can drive both apps in unison |

Rungs are earned **per role**, because they are different work. Levels 0 and 1
need only a producer. Level 2 changes character: round-trip is undemonstrable
unless you can also *consume*, and most tools in this genre are write-only —
they export and never import. That is exactly why so much interoperability
stalls at portability. A claim therefore reads `produce: 2, consume: 1,
operate: 0`, never one number.

Every suite in `fixtures/` is tagged with the rung it tests, and the level you
have earned is the highest one with nothing failing beneath it. Derive it from a
run rather than writing it down: a manifest a producer writes is a promise, one
that falls out of the suite is evidence.

---

## Envelope

```json
{
  "format": "pkm-interchange/0",
  "producer": { "name": "hermes", "version": "2.1.0" },
  "conformance": {
    "produce": 2, "consume": 1, "operate": 0,
    "bindings": ["file"],
    "profiles": ["task", "note"],
    "features": ["series", "placement", "relations"],
    "unsupported": ["attachments"]
  },
  "types": [ ... ],
  "objects": [ ... ],
  "collections": [ ... ],
  "series": [ ... ],
  "relations": [ ... ]
}
```

`conformance` is a manifest of what the producer actually implements. Partial conformance is normal and expected — weekend projects will not implement everything, and a format where the only options are "complete" and "non-conformant" produces zero conformant implementations. Declare honestly; `unsupported` is not an admission of failure, it is the mechanism working.

Every top-level array is optional. An export containing only `types` and `objects` is valid.

## Identity

Every object, type, collection, and series has an `id`: a string, unique within the export, opaque to consumers. Do not parse it. Do not assume it is a UUID. Do not assume it is stable across exports from the same producer unless the producer sets `"stableIds": true` in `producer`.

## Unknown fields

**Any property a consumer does not recognise MUST survive a round-trip byte-identical.**

This is the single most important rule for interoperability between tools that model things differently, and it is the one implementations skip. If my app has a field yours has never heard of and you re-export, mine must still be there. Store unknowns opaquely; do not normalise, reorder, or coerce them.

→ `fixtures/roundtrip.json`

## Loud failure

**A consumer that meets something it cannot represent MUST report it. It MUST NOT silently coerce.**

The characteristic interop disaster is not rejection, it is silence: my task recurs from its completion date, yours has no such concept, yours imports it as schedule-anchored, and I find out in March when my haircut reminder has drifted a month. Import either preserves the semantics, preserves the data opaquely and reports reduced fidelity, or fails. It never quietly does something else.

→ `fixtures/conformance.json`

---

## Types (L1)

The type system is open. Producers do not share an ontology, so an export carries its own type definitions and is self-describing.

```json
{
  "id": "t_task",
  "name": "Task",
  "fields": [
    { "key": "title",  "kind": "text",     "required": true },
    { "key": "dates",  "kind": "datespan", "startLabel": "Available", "endLabel": "Due" },
    { "key": "status", "kind": "enum", "options": ["todo", "doing", "done"] },
    { "key": "owner",  "kind": "reference", "targetType": "t_person" }
  ],
  "profiles": {
    "task": {
      "title": "title",
      "start": { "field": "dates", "part": "start" },
      "due":   { "field": "dates", "part": "end" },
      "status": "status",
      "completeValues": ["done"]
    }
  }
}
```

### Value kinds (L0)

`text` · `richtext` · `number` · `boolean` · `url` · `date` · `datetime` · `datespan` · `enum` · `reference` · `attachment`

Dates are `YYYY-MM-DD`. Datetimes are `YYYY-MM-DDTHH:mm` with an optional `timezone` on the field (IANA name). A `datespan` is `{ "start": ..., "end": ... }`, both optional, with producer-supplied labels — do not assume the labels are "Start" and "Due".

There is deliberately **no recurrence value kind**. Recurrence is not a value; see Series.

### Profiles

A profile declaration maps a producer's own fields onto a vocabulary a stranger can consume. It is a *mapping*, not a claim of identity — a type named `Chore` or `Errand` or `明日の仕事` declaring the `task` profile is consumable by any task-aware tool.

v0 profiles: `task`, `event`, `contact`, `note`.

A type may declare several. A type may declare none, in which case consumers can still read its fields generically and must not guess.

→ `fixtures/profile.json`

---

## Objects

```json
{
  "id": "o_412",
  "type": "t_task",
  "properties": { "title": "Weekly review", "status": "todo",
                  "dates": { "start": "2026-08-25", "end": "2026-08-26" } },
  "tags": ["admin"],
  "archived": false,
  "created": "2026-08-19T15:55:06Z",
  "updated": "2026-08-19T15:55:06Z"
}
```

`archived` means hidden from normal views but not deleted. A consumer with no such concept must preserve the flag rather than dropping the object or un-archiving it.

---

## Series — recurrence (L1 + L2)

Recurrence is an object, not a field. The rule lives on a series; instances are real objects that point at it.

This is not a stylistic choice. **Schedule-anchored and completion-anchored recurrence are different computational objects.**

A schedule-anchored rule is a set generator: a pure function of (rule, start) that enumerates to infinity without knowing anything about what the user did. That is what `RRULE` is.

A completion-anchored rule is a state machine: the next occurrence depends on an event that has not happened yet. It cannot be enumerated. **Only one future instance is ever knowable.**

```json
{
  "id": "s_review",
  "rule": {
    "anchor": "schedule",
    "freq": "weekly",
    "interval": 1,
    "byWeekday": ["WE"],
    "end": { "type": "never" },
    "monthEnd": "skip"
  },
  "horizon": 4,
  "instances": ["o_410", "o_411", "o_412"]
}
```

- `anchor`: `"schedule"` | `"completion"`.
- `horizon`: how many unstarted instances the producer materialises ahead. **If `anchor` is `"completion"`, `horizon` MUST be 1.** Anything else is unrepresentable, not merely unusual.
- `end`: `{"type":"never"}` | `{"type":"after","count":N}` | `{"type":"on","date":"YYYY-MM-DD"}`. Note that `after` is enforced by counting `instances`, not by a stored index — an occurrence counter carried on the rule is instance state hiding in a rule object, and every site that copies the rule then has to nurse it.
- `monthEnd`: `"skip"` | `"clamp"`. **Required for monthly and yearly rules.**

### On `monthEnd`

A monthly rule anchored to January 31 has two defensible behaviours. `skip` omits February and gives March 31 — this is what `RRULE`, EventKit, and most calendars do. `clamp` gives February 28, and then, in most implementations, permanently re-anchors to the 28th thereafter.

The format does not pick. It requires you to say. Silently clamping rewrites the user's intent after one short month, and the user never finds out; declaring it means the behaviour travels with the data and a consumer can reproduce it exactly.

If your implementation clamps, say `"clamp"`. Do not say `"skip"` because it sounds more correct.

→ `fixtures/recurrence.json`

---

## Collections and placement (L2)

A collection is a container with members. Its `kind` is a hint about rendering. Its `placement` is the part that matters.

```json
{
  "id": "c_priorities",
  "name": "This quarter",
  "kind": "matrix",
  "placement": {
    "semantic": true,
    "regions": ["urgent-important", "urgent-later",
                "calm-important", "calm-later"]
  },
  "membership": { "mode": "explicit" },
  "members": [
    { "object": "o_412", "region": "urgent-important", "position": "a0" }
  ]
}
```

**`placement.semantic` is the whole point.** When true, a member's `region` is a judgment the user made — dropping it destroys information, and a consumer that cannot represent it must report reduced fidelity rather than importing the members as a flat list. When false, placement is furniture: canvas coordinates, masonry sizing, collapse state. Consumers may discard it freely.

Semantic placement uses **named regions, never coordinates**. `"urgent-important"` survives being opened in a tool that draws no grid. `(340, 120)` does not.

`position` is an opaque ordering token. Compare byte-wise; do not parse it as a number.

→ `fixtures/placement.json`

---

## Derivations (L3)

Membership can be stated or computed, and the difference is not cosmetic.

```json
"membership": {
  "mode": "query",
  "materialized": false,
  "query": { "match": "all", "conditions": [
    { "field": "status", "op": "eq", "value": "doing" }
  ]}
}
```

- `mode: "explicit"` — `members` is the truth.
- `mode: "query"`, `materialized: false` — the query is the truth. Any `members` array is a **snapshot for reference only** and MUST NOT be treated as authoritative. Re-exporting it as an explicit collection silently freezes a live query into stale facts.
- `mode: "query"`, `materialized: true` — the query produced these members and they were then fixed. `members` is the truth.

A consumer with no query engine may import a `materialized: false` collection as explicit **only if it reports the downgrade.**

→ `fixtures/derivation.json`

---

## Relations (L2)

Two mechanisms, deliberately.

**Declared references** are fields of kind `reference` with a `targetType`. The type system knows about them; they are structural.

**Ad-hoc relations** are edges nobody declared:

```json
{ "from": "o_412", "to": "o_88", "type": "supports" }
```

`type` is a free string. There is no vocabulary and v0 does not attempt one — the moment you standardise an edge vocabulary you are running an ontology committee, which is where this genre of project goes to die. Consumers preserve relation types they do not understand and must not drop them.

`via` says where an edge came from: `"inline"` for one written into prose (see below), `"edge"` for one drawn — on a canvas, say. Absent means unspecified. It is not decoration: an edge in a sentence and an edge someone dragged are edited in completely different ways, and a consumer that flattens them together will offer to change the wrong one.

A declared reference is **not** repeated here. It already exists as a property value, the type system already says what it points at, and copying it into `relations` gives a consumer two records of one fact that drift the moment somebody edits either.

### What a link's type is, and where it lives

Nothing here says what *kind* of link an edge is, and that is deliberate.

The kind of the **thing at the far end** — person, project, book — belongs to that thing. It is on the target object's type, exactly once. Stamping it onto the edge as well means retyping an object silently falsifies every edge pointing at it.

The kind of the **relationship** is a different question with two different answers. A declared reference already carries it: the field is named `owner` or `project`, and its `targetType` says what it accepts. That is a link type, declared by the person who built the type, and it needs no help.

An inline mention has no relationship type, because nobody declared one. Somebody typed a name in a sentence. Inventing `references` or `relates-to` for it would be guessing, and guessing at meaning is the thing this format exists to stop. `type` on a mirrored edge says how the edge was made, not what it means, and a consumer that needs more looks at the target.

### An edge that points at nothing yet

```json
{ "from": "o_1", "type": "mentions", "via": "inline",
  "field": "body", "label": "the roofer", "resolved": false }
```

`resolved: false` marks an edge whose far end is not in this export — deleted, or out of scope, or never created. Consumers keep it: dropping an edge because its target is missing destroys the only remaining record that the writing points at something.

`label` is what the mention said. Without it an unresolved edge is a bare id, and the prose around it cannot be rendered at all — a reader is left with a sentence that plainly refers to somebody and no way to know who. With it, a tool can show the name, offer to create the thing, or offer to clear the link.

`to` may therefore be **absent**: a mention of a person who does not exist yet is a real and common thing to write, and it has a label and no id. A relation must carry `from`, and must carry `to` or `label` — an edge with neither is not an edge, it is a row.

### What the link expected

```json
{ "from": "o_1", "type": "mentions", "via": "inline",
  "label": "the roofer", "expects": "contact", "resolved": false }
```

An interface that offers different keys for different things — one for people, one for anything — knows something at the moment of writing that is nowhere else afterwards: **what the writer meant to point at**. `expects` is that, and it is the one piece of type information an edge may legitimately carry.

It is not a copy of the target's type. The target's type belongs to the target, and duplicating it means retyping an object silently falsifies every edge pointing at it. `expects` is a statement about the *link*: this was written as a reference to a person.

- When the target resolves, **the target is authoritative** and a disagreement is legal. Somebody meant to name a person and named a project; that is worth showing a reader, and it is not an excuse to coerce either end. A consumer keeps both.
- When nothing resolves, `expects` is the only type information that exists anywhere. It is what lets a tool offer to create the right kind of thing instead of an untyped stub.

It takes a **profile name**, not a type id. A type id is one producer's private key and means nothing to anyone else; `contact` is the vocabulary this format already has for saying what something is.

There is deliberately no equivalent for the near end. The origin's type is knowable twice already — the `from` object carries it, and `field` names the property whose schema declares it. A third copy would buy nothing and drift like the first.

And note what is *not* here: a tag. A tag is not a link to an object. It has no far end to resolve, and it lives on the object as `tags`.

→ `fixtures/inline.json`

---

## Inline references (L2)

Most of the graph in a knowledge base is not in the schema. It is in the writing: a link dropped mid-paragraph, a `[[wikilink]]`, an `@name` typed into a sentence. A format that models only declared reference fields cannot see any of it, and will report a library of ten thousand densely linked notes as having almost no edges at all.

The rule has two halves, and the second is the one nobody implements.

**Prose is opaque and must survive byte-identical.** This is the round-trip rule, and it is absolute: `[[double brackets]]`, `((double parens))`, `@names`, whatever the next tool invents. The format deliberately standardises no markup dialect. Normalising someone's prose into your syntax is rewriting their writing, which is the one thing in a knowledge base nobody wants touched.

**Every inline reference is also mirrored into `relations`.**

```json
{ "from": "o_1", "to": "o_2", "type": "mentions",
  "via": "inline", "field": "body" }
```

That is the whole proposal. Prose stays a black box; its edges are stated in a place anyone can read. A consumer that cannot parse your dialect still holds your graph — and, crucially, a consumer that is about to *rewrite* your prose can tell what it is about to break. Without the mirror that loss is not merely unreported, it is undetectable: a tool cannot know it destroyed a link in a syntax it never understood.

- A producer whose prose contains references **MUST** mirror them, naming the field they were found in.
- A consumer **MUST NOT** drop `via: "inline"` relations, even though it cannot find them in the text.
- A consumer that rewrites prose and cannot guarantee the mentions survive **MUST** report reduced fidelity.
- `field` **MUST** name a field the object's type actually declares. An edge that cannot be traced back to a sentence is either a stale export or a producer guessing, and a consumer has no way to tell which.

There is no syntax vocabulary here and there should not be one. Standardising markup is the same trap as standardising an edge vocabulary, one layer down.

→ `fixtures/inline.json`

---

## The live binding (L4)

Everything above describes a file. A format that also governs an API, an agent
tool surface and a database write needs three things a snapshot never does, and
this section is those three. The vocabulary does not change — types, objects,
profiles, placement, series, relations are the same words here. What changes is
how they are carried, which is why this is a *binding* rather than a second
format. `bindings` in the manifest names the ones you offer: `file`, `http`,
`mcp`, or whatever comes next.

### Partial writes

```json
{ "set": { "status": "done" }, "unset": ["owner"], "version": 7 }
```

Two moves and no third. **A property named by neither is untouched** — including
every property the implementation has never heard of. This is the round-trip rule
at write time, and it is the half that gets skipped: a tool can be scrupulous
about an export and still destroy a field the moment an agent changes a title,
because the agent sent the two keys it knew about and the server treated the
payload as the whole object.

`unset` is the only way to remove a value. Not `null` — that collides with every
model where null means something. Not an absent key — that is the case above.

If you version objects, a patch may carry `version`, and a stale one **MUST** be
refused rather than merged. Merging looks helpful and is how one client's edit
silently reverts another's, with the writer told it landed.

### Every write answers for itself

```json
{ "ok": true, "fidelity": "reduced", "reports": ["series.anchor"] }
```

Loud failure, applied to writing. A server that stores what it can and answers a
bare `ok` has told the caller everything went in. `"fidelity": "full"` is a
promise, and it is worth something only because it is not said defensively —
report reduced on everything and the field stops carrying information.

### Capabilities are a question, not a header

A manifest on an export describes that file. A live surface has to answer
**before** a client writes, so `conformance` is something you can ask for. Same
shape as the envelope's, with `bindings`, and the same rule: it is a promise
about behaviour, not an aspiration. Claiming `operate` while offering only the
`file` binding is claiming to be operable with nothing to operate.

### The change feed

```json
{ "seq": 976, "object": "o_1", "op": "update", "cause": "membership" }
```

Deletions **MUST** be reported. A follower cannot tell "deleted" from "not in the
page I asked for", and diffing everything is precisely what a feed exists to
avoid.

`op` describes **the object**, never the row that changed in your storage. Only
an object can be deleted; a membership, a tag or a placement going away is an
`update` to the object that had it. This one is worth stating plainly because it
is invisible in testing: a card moving between two columns is a membership
removed and re-added, so a feed reporting the child row's own operation announces
a live object as deleted every time somebody uses a board. `cause` is optional
and says which part moved.

And rows arrive in order, so **the last row about an object is the current one —
in both directions**. A delete outranking everything after it is defensible right
up until something legitimately comes back, and then the follower is missing an
object that exists with nothing to correct it short of a full re-read.

→ `fixtures/operational.json`

---

## Versioning

One integer in `format`. Additive changes do not bump it; the round-trip rule is what makes that safe.

## Checking yourself

```
npx pkm-check ./my-export.json
```

Paste the failures at your agent along with this file.
