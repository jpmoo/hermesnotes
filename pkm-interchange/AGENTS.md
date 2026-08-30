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

## Whose name is that key?

Structural objects here are open — a type, a field, a collection, a region, a member, the envelope itself. A producer may hang whatever it likes on them and it travels untouched.

**Unprefixed keys belong to the format. A producer's own go under a prefix it controls.**

```json
{ "name": "delegate-wait", "label": "Delegate & Wait", "hermes:color": "#5fa4b5" }
```

Without this, two producers write `color` meaning different things and a consumer cannot tell which it is holding; worse, a later version of the format standardises `color` and every producer that got there first is now wrong in a way no validator can see. A prefix costs seven characters and makes both impossible.

This is about *structural* keys. An object's `properties` are keyed by the producer's own declared fields and are not in this namespace — `properties.deadline` is data, not an extension.

**A collection's `properties` are not that carve-out, and take the prefix.** The difference is whether a consumer can find out what a key means. An object's properties are described by a type it can read: `deadline` is declared, with a kind, and a stranger can render it. A collection has no type, so nothing there is declarable and nothing outside the producer can know what `table_sort` is. That makes it an extension on a structural object, which is exactly what the prefix is for.

This was found the way most of this document was — by looking at what a real producer actually emitted. Hermes was spending twenty-nine unprefixed names on collections, among them `sort_mode` and `table_sort`, which are this document's own open limit *"no sort or grouping on a collection"* being solved privately under the name v0.1 will want. The failure mode a paragraph above is not hypothetical; it had already started.

A consumer preserves prefixed and unprefixed keys alike; the round-trip rule does not care whose they are. What the prefix buys is the ability to know, and to write your own without asking anyone.

## Unknown fields

**Any property a consumer does not recognise MUST survive a round-trip byte-identical.**

This is the single most important rule for interoperability between tools that model things differently, and it is the one implementations skip. If my app has a field yours has never heard of and you re-export, mine must still be there. Store unknowns opaquely; do not normalise, reorder, or coerce them.

→ `fixtures/roundtrip.json`

## Loud failure

**A consumer that meets something it cannot represent MUST report it. It MUST NOT silently coerce.**

The characteristic interop disaster is not rejection, it is silence: my task recurs from its completion date, yours has no such concept, yours imports it as schedule-anchored, and I find out in March when my haircut reminder has drifted a month. Import either preserves the semantics, preserves the data opaquely and reports reduced fidelity, or fails. It never quietly does something else.

→ `fixtures/roundtrip.json`

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

**The list is open.** A producer with a kind nobody has standardised declares it anyway and it travels untouched; consumers treat an unknown kind as opaque and must not drop the field. The alternative is that a field's type becomes unsayable while its values survive, leaving a consumer holding data it cannot describe.

There is deliberately **no recurrence value kind**. Recurrence is not a value; see Series.

**An empty string is not a value.** Real libraries are full of them, where a field was opened and left alone. Producers should omit rather than store `""`; consumers must read it as absent. Saying nothing about this was worth one consumer reading no start date and another reading a start that fails to parse and showing the epoch.

**Cardinality.** `"many": true` on a field says its value is a list. One task belongs to two projects and one note cites four sources — the commonest shape in a knowledge base — and without a way to declare it a producer either drops the extras or smuggles them somewhere unreadable. It is checkable in both directions: a `many` field holds a list, a field without it does not. A consumer whose own model allows only one may take the first, and **must report reduced fidelity when it does**.

→ `fixtures/values.json`

### Profiles

A profile declaration maps a producer's own fields onto a vocabulary a stranger can consume. It is a *mapping*, not a claim of identity — a type named `Chore` or `Errand` or `明日の仕事` declaring the `task` profile is consumable by any task-aware tool.

v0 profiles: `task`, `event`, `contact`, `note`, `journal`.

A type may declare several. A type may declare none, in which case consumers can still read its fields generically and must not guess.

**A mapping must land.** Wherever a v0 profile names one of the producer's fields, that field has to be declared on the type. A mapping onto a field that does not exist reads as a declaration and delivers nothing: the consumer that trusts it gets `undefined` and cannot tell that from a task with no due date. It is the one way to claim level 1 while providing none of it, and nothing else in an export gives it away — the document is well-formed and the profile is spelled correctly.

Three things inside a profile are not field names, and none of them is checked this way: a list of values such as `completeValues`; the halves of a compound field, named as `{ "field": "dates", "part": "start" }`, where the rule applies to `field`; and `content`, the one reserved slot outside the property bag. Profiles outside the v0 vocabulary are carried and not interpreted, so their mappings are not checked either.

#### The page for a date

```json
"profiles": { "note": { "title": "title", "content": "content" },
              "journal": { "date": "on" } }
```

A journal object is the page for a day: Obsidian's daily note, Logseq's journal,
Roam's daily note, Tana's day node, and the same idea under a different name in
most of the rest. It is one of the most portable ideas in this genre and, until
now, one of the least sayable here.

`date` names the field holding the day, as `YYYY-MM-DD`. That is the whole
mapping. A journal object is almost always a `note` as well, and a type may
declare both — this profile adds the one thing `note` cannot say, which is
*which day this is*.

Deliberately not a query. "The note for 2026-08-25" reads like a search and is
not one: it is an object with a date identity, and treating it as a search would
have made a shared query language a prerequisite for the most ordinary feature
in the genre. A consumer with no query engine finds it by looking, and a producer
with a route for it is offering a shortcut rather than the only way in.

**One page per day is expected, and duplicates are not a consumer's to resolve.**
Producers create these lazily, and a producer that has raced with itself can end
up with two pages for one date. A consumer that finds several must not silently
pick one — that is how somebody's morning notes vanish behind an identical,
empty page — so it reports `journal.duplicate` and shows what it found.

→ `fixtures/journal.json`

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

`content` is the one reserved slot outside the property bag: the object's body. A document with a body and some metadata about it is the dominant shape in this genre — a Markdown file with frontmatter is exactly that — and a format where everything must be a property has nowhere to put the body. A profile names it like any other target: `"body": "content"`. Producers that keep the body in a field carry on doing so and nothing changes for them.

`archived` means hidden from normal views but not deleted. A consumer with no such concept must preserve the flag rather than dropping the object or un-archiving it.

### Where a thing lives

An object may carry `url`: an absolute address where a person can go to see it.
So may a collection.

```json
{ "id": "o_412", "type": "t_task", "url": "https://notes.example/block/o_412", ... }
```

"Open this where it lives" is close to universal and there is nothing to argue
about: a producer knows its own URLs and nobody else can guess them. Without it,
every consumer that wants to link to anything has to hardcode one producer's
routing scheme, which is a link that works in exactly one library and sends a
person nowhere in any other.

**It is a value, not a rule.** The obvious cheaper design — a template in
`producer`, `"https://notes.example/block/{id}"` — is a construction rule, and
shipping one licenses exactly what the rest of this format forbids. A consumer
holding a template will build addresses for objects that never travelled,
including ones that do not exist, and it will do so by **parsing and
interpolating an id that is supposed to be opaque**. One string per object costs
bytes; a template costs the id rule. An address a producer hands you is not a
licence to construct another one.

A producer that offers addresses declares `addresses` in `features`. Consumers
must treat `url` as opaque, must not rewrite it, and must not synthesise one for
an object that lacks it — absent means *this producer does not publish an
address for this*, which is different from an address it forgot to send.

A producer may publish more than one kind of address; the others go under its
own prefix, like anything else. Hermes hands out both a shareable `https` link
and a `talaria://` one that resolves locally, and only the first is `url`,
because `url` is the one a stranger can use.


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
- `byMonthDay`: which day of the month the rule is anchored to. **Also required for monthly and yearly rules**, because a rule that can only be read by looking at one of its instances is not a rule — and the instance may already have been clamped, in which case it says the 28th and the intent said the 31st.

### On `monthEnd`

A monthly rule anchored to January 31 has two defensible behaviours. `skip` omits February and gives March 31 — this is what `RRULE`, EventKit, and most calendars do. `clamp` gives February 28, and then, in most implementations, permanently re-anchors to the 28th thereafter.

The format does not pick. It requires you to say. Silently clamping rewrites the user's intent after one short month, and the user never finds out; declaring it means the behaviour travels with the data and a consumer can reproduce it exactly.

If your implementation clamps, say `"clamp"`. Do not say `"skip"` because it sounds more correct.

Clamping is only implementable at all with `byMonthDay`: clamping without knowing the day you are clamping *from* is just moving to the end of the month, and it is what turns one short February into a series permanently on the 28th.

→ `fixtures/recurrence.json`

---

## Containment (L2)

Some applications are outlines. A block sits *inside* another block, in order,
and the nesting is the document rather than a view of it — Logseq, Roam, Tana
and Workflowy are all built that way, which is a large fraction of this genre.

```json
{ "id": "o_child", "type": "t_note", "parent": "o_parent", "position": "a1" }
```

`parent` is the id of the object this one is inside. An object with no `parent`
is a root. `position` orders it among its siblings and is the same opaque
ordering token collections use: **compare byte-wise, do not parse it as a
number**, and do not regenerate it on import.

**Containment is not membership and not a relation.** A collection says *these
things are in this list*; an edge says *this thing refers to that one*; neither
says *this block is the third thing inside that block*. An outline approximated
with reference fields keeps the edges and loses the order and the containment,
which is what it means to say the tree was smuggled rather than expressed.

**The same object may be a child and a member.** A block nested under another
can also sit in a collection, and it carries a `position` in each — one among
its siblings, one among that collection's members. They are different orderings
of different things that happen to share a spelling, because they are the same
idea applied twice.

**A cycle is invalid.** An object that is its own ancestor describes no document
and hangs any consumer that walks it, so it is a structural error rather than
something to cope with: `hierarchy.cycle`.

**A parent that names nothing here is not an error.** A `since` read is a
delta and will routinely carry a child whose parent has not changed. A consumer
that cannot find the parent treats the object as a root for now and asks again;
it must not drop it, and it must not invent a placeholder parent.

**Flattening is permitted and must be reported.** A consumer with no notion of
containment may import an outline as a flat list — refusing helps nobody — but
the nesting is what the document *was*, so this is `reduced` fidelity reporting
`hierarchy`. Keep the `parent` and `position` keys whatever you do with them:
the round-trip rule applies here as everywhere, and a tool that flattens an
outline and hands it back should hand back the outline.

→ `fixtures/hierarchy.json`

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

A region is a string, or an object when the name a machine matches on is not the words a person reads:

```json
"regions": ["do", { "name": "delegate-wait", "label": "Delegate & Wait" }]
```

`name` is an identifier — it is what a member's `region` matches and what a write names, so it must not change when somebody edits the wording. `label` is for display and carries no meaning. A bare string is both at once, which is right whenever the two agree.

The object is **open**, like everything else here. A producer that colours its regions says so under its own key and the colour travels untouched; the format does not name it, because what colour a quadrant is drawn in is not something another tool needs to agree about. Consuming a producer's region definitions to build this list and dropping whatever else was on them is the round-trip rule broken by the code that publishes the region.

The distinction is not fussiness. Producers derive the name from the label — slugging "Delegate & Wait" into `delegate-wait` is the obvious implementation — and a format with nowhere to put the label makes that derivation lossy: the board arrives with regions a consumer can match on and cannot render, so it draws "Region 3" over somebody's own words.

`position` is an opaque ordering token. Compare byte-wise; do not parse it as a number.

A member is an object — `{ "object": "o_412", … }`. A bare id is legal shorthand for one with nothing else to say, and expanding it to the object form is **not** a fidelity loss. This is the one place the format has two spellings for one thing, and saying so is cheaper than leaving every implementer to discover that their round-trip does not compare equal.

→ `fixtures/placement.json`

### The order a collection is shown in

`position` gives every collection *an* order. `order` says when that order was
not the point.

```json
"order": {
  "sort": [
    { "by": { "field": "schedule", "part": "end" }, "direction": "ascending" },
    { "by": { "field": "title" }, "direction": "ascending" }
  ],
  "groupBy": { "meta": "type" }
}
```

**`sort` present means the stored order is not authoritative.** Absent, `position`
is the truth and a consumer that reorders is destroying something a person
arranged by hand. There is no `mode` flag and no `manual` value: the presence of
the key is the whole statement, the same way an absent `membership.mode` means
`explicit`. A producer whose user has a saved sort switched off emits no `sort`
and keeps its own under its own prefix, which is the honest reading of that
state rather than a third mode to interpret.

Positions are still emitted under a `sort`, and are still a snapshot worth
having — a consumer that ignores `order` entirely renders by `position` and gets
the sorted order as it stood at export. This is the same courtesy
`membership.materialized` describes and it needs no flag either, because reading
`sort` and reading `position` cannot disagree about *what to draw*, only about
what to do when a value changes.

**`by` names a field or a fact about the object, and says which.**

```json
{ "field": "due" }                        // a field key
{ "field": "schedule", "part": "end" }    // half of a compound field
{ "meta": "type" }                        // not a field at all
```

This is the shape a profile mapping already uses, reused deliberately. The
alternative — a bare string with `type` reserved — costs a version bump the
first time somebody names a field `type`, and types here are user data, so
somebody will. `meta` in v0 is exactly `type`, `created` and `updated`; anything
else is an error rather than a key to guess at.

`direction` is `"ascending"` or `"descending"`, and defaults to ascending.

**`{ "meta": "type" }` groups by id and sorts by name.** The two want different
things from the same key and saying so is cheaper than letting each implementer
pick. A group key has to be stable, so it is the type's id and a consumer looks
up the name to draw the heading; nobody sorts a list by opaque ids, so as a sort
key it orders by the type's `name` — which is what the heading says, and what a
person reading "sorted by type" expects to see.

**A missing value sorts last, in both directions.** This is the rule most worth
writing down, because it is the one every implementation decides silently and
differently. Sorting by due date descending should put the furthest-out dated
thing at the top and the undated ones out of the way; putting them first because
`undefined` compares low is a defensible reading of the data and a useless
reading of the intent. An empty string is a missing value here, as everywhere
else in this format.

**Values compare byte-wise unless both are numbers.** ISO dates sort correctly
under that rule, which is why the format asks for them; a locale-aware collation
does not, and puts a different thing at the top of the list depending on where
the reader is sitting. This is the same rule `position` already states, for the
same reason.

**Ties fall through to the next key, and then to `position`.** A sort that names
no tiebreak is not thereby unstable — the stored order is the last resort, so two
objects with the same due date come out in a stable order rather than whichever
one the consumer's sort happened to touch first.

**`groupBy` is one key, in the same vocabulary, and is orthogonal to `sort`.** A
collection may be grouped and manually ordered within its groups; that is
`groupBy` with no `sort`. Groups are ordered by their key under the same
missing-last rule, and an object whose key is missing lands in a final group
whose key is `null` rather than being dropped.

**What does not belong here.** Column widths, view modes, chip counts, whether
the header is sticky. The line is the one `placement.semantic` already draws:
sort and grouping change *which objects a person sees first*, which is a
decision; how wide a column is drawn is furniture, and belongs under the
producer's own prefix where it will survive a round trip and bind nobody.

**Losing it is a reduced import.** A consumer that cannot sort keeps the members
and reports `order.sort`; one that cannot group reports `order.grouping`. This
is the derivation rule pointed at a different derived thing: the members do not
change, but the arrangement goes stale the moment a due date does, and a user
who believes they still have a sorted list will not find out for weeks.

→ `fixtures/sort.json`

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

**And the snapshot has to be the query's answer.** Obvious enough to go unsaid, which is why it is said here: a producer whose collection holds *both* a query and objects somebody placed by hand will reach for the placements, because a placement is a decision and a snapshot is only a courtesy. Both halves of that are true and the conclusion is wrong — a consumer entitled to read `members` as what the query returns will draw a board full of things the producer does not show. The real case that taught this was a matrix exporting 37 members under a query matching 16, arriving with 21 completed tasks on it.

A placement whose object the query no longer returns is not a member and cannot travel as one. It is still a decision somebody made, so keep it under your own prefix and read it back on import; the alternative is that completing a task forgets which quadrant it was in.

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

### A link is a link

```json
{ "from": "o_1", "to": "o_2", "type": "mentions", "via": "inline", "field": "body" }
```

That is all of it, and `to` is **required**. A link says one thing: this points at that. Every question a reader might go on to ask — what kind of thing is it, does it still exist, was it ever created, what is it called — is a question about the far end, and belongs to the far end.

The temptation to answer those on the edge is strong and it is always the same mistake. A copy of the target's type falsifies itself the moment the target is retyped. A copy of its title falsifies itself on rename. A `resolved` flag is a join the consumer can do itself in one pass. Each looks like a convenience and each becomes a second version of a fact, drifting from the first with nothing to reconcile them.

### A name that isn't a thing yet

So what about `[[the roofer]]`, written before any roofer exists?

That is not a link with a missing end. It is a link to a **stub**: an object that exists, has an id, has a name, and does not yet have a type.

```json
{ "id": "o_roofer", "stub": true,
  "properties": { "title": "the roofer" },
  "suggests": "contact" }
```

`stub: true` says this is a name somebody wrote rather than a thing they made. `suggests` is optional and names a profile — what the writer appeared to mean, which is worth keeping when an interface has separate ways to reach for a person and for anything, because at the moment of writing that is real information and nowhere else records it. It is a suggestion about the stub, not a claim about the link.

The point of doing it this way is what happens next. When the stub becomes real it keeps its id: `stub` comes off, a type goes on, and **every link pointing at it is already correct**. Nothing is rewritten. A producer that instead stores the name inside the prose has to find and edit every piece of writing that mentioned it, and has to do so atomically, and has to tell every open editor to reread — which is a large amount of machinery to own for a case that need not exist.

A stub is an ordinary object in every other respect. It can be exported, linked, listed, and swept up if nothing points at it any more.

**What a new id costs.** Minting one at the moment of writing has three consequences a producer has to answer for, and they are worth stating because the alternative — resolving names at read time — answers them by accident.

*Who mints it.* The client, before the write lands. An id that has to be fetched cannot be used offline and cannot be used in the same keystroke that created the reference. A producer that mints ids server-side has to either block or backfill, and backfilling is the prose rewrite this design exists to avoid.

*Two people typing the same name.* Resolving by name converges for free: two writers naming the roofer land on one roofer without anyone deciding. Ids do not, so the picker has to offer existing stubs, and convergence stops being automatic and becomes chosen. That is a real cost, and it buys the case that name-matching gets wrong — two different Janes stay two people.

*Names that were never chosen.* Text typed and never picked from a picker is text. It is not a link, it mints nothing, and it resolves to nothing. A producer that quietly links on a name match has reintroduced every problem above with none of the compensating clarity.

**Render hints.** Nothing stops a producer stamping the target's title or icon onto an edge to draw a chip without a lookup, and the round-trip rule means it will survive. Two cautions, in order of importance. Name it as a hint — `targetTitleHint`, never `title` — because a field that reads as a fact will be treated as one by the next person. And check whether it buys anything first: a renderer usually has to resolve the target regardless, for its current title or to find out the thing has been deleted, and everything else arrives in that same answer.

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

### Reading

A read returns an **envelope** — the same document a file export carries, over
the wire. Not a bare array of objects, not a page of rows in the producer's own
shape. This is what makes `bindings` a claim worth reading: a client that knows
the format knows what it is getting back before it asks.

```
GET <base>/interchange
GET <base>/interchange?since=<cursor>
GET <base>/interchange?profile=task
```

Two narrowings in v0, both optional, both refinements of the same document.
A producer that supports neither still conforms; it simply answers the whole
library every time, which is fine at small sizes and nothing else.

#### `cursor` — where you are now

Every read carries a top-level `cursor`: an opaque string naming the point the
answer was taken at. Hand it back as `since` to ask what has happened.

```json
{ "format": "pkm-interchange/0", "cursor": "976", "types": [ ... ], "objects": [ ... ] }
```

**Opaque.** Not a timestamp to compare, not an integer to add to. It is a
sequence number in one producer and a hash in the next, and a client that parses
one has bound itself to that producer as surely as if it had called a private
route.

#### `since` — what changed

The answer is an envelope holding only what moved, plus a `changes` array saying
what happened to each:

```json
{
  "cursor": "1013",
  "objects": [ { "id": "o_1", ... } ],
  "changes": [
    { "seq": 1004, "object": "o_1", "op": "update", "cause": "membership" },
    { "seq": 1011, "object": "o_7", "op": "delete" }
  ]
}
```

**Deletions MUST appear in `changes`.** An object that is simply absent from a
delta is indistinguishable from one that did not change, and a follower has no
way to tell those apart — diffing the whole library to find out is exactly what
a delta exists to avoid.

**A producer that cannot answer the question MUST say so, not answer it badly.**
Change logs get pruned, and a client that has been away longer than the log is
kept is one the delta cannot catch up. Answer `410 Gone` — or the binding's
equivalent — so the client re-reads in full. Silently returning the changes you
still happen to hold produces a follower that is quietly missing objects and has
nothing to tell it so, which is the worst of the three outcomes and the one that
looks like success.

#### `profile` — what kind

`?profile=task` narrows to objects whose type declares that profile. A kanban
asks for tasks and does not carry a library of recipes around.

**A narrowed answer is still a whole envelope.** Every type an included object
points at travels with it, whether or not that type matched — an object whose
type is missing cannot be read at all, and narrowing that produces unreadable
objects has saved bandwidth by destroying the thing it was carrying. The general
rule, which holds for every read: **an object's `type` MUST name a type declared
in the same document.**

A producer may return more than was asked for. Narrowing is permission to send
less, never an obligation, and a producer that finds filtering expensive should
send everything rather than get it wrong.

### Asking a collection what it holds now

```
GET /interchange/collections/{id}
```

Answers an envelope narrowed to one collection: the collection, the objects it
holds, and the types those objects need. A read, so it is safe to repeat.

**Its membership is evaluated at the moment it is asked.** That is the whole
point of it. A cursor tells you what has *changed*, and a computed collection's
membership changes without anything changing: a task whose due date falls into
range today was not edited, so no feed carries it and no cursor moves past it. A
follower doing everything right — catching up on every change, never missing an
event — still holds a list that quietly stopped being true. This is the only way
to ask.

**It does not make the query authoritative.** `membership.mode` stays `query`
and `materialized` stays `false`. A fresh answer is still a snapshot; it is
merely a snapshot from a second ago rather than from the last export, and a
consumer must no more freeze this one into an explicit list than the other.

**A producer that cannot re-evaluate answers 404 or 405.** That is not an error
and must not be reported as one: it is a producer that has not implemented this
verb, which is a condition that ends by itself when it is upgraded. A consumer
treats it exactly as it treats any other verb the far end does not offer, and
falls back to the snapshot it already has.

**What this deliberately is not.** A shared query language. Understanding
somebody else's saved search and getting a fresh answer out of it are two
different problems, and only the second one is small: any producer with saved
searches can run its own and say what came back, while agreeing on a language to
express them in is a design nobody has got right yet and the wrong one is worse
than none. `membership.query` still travels opaquely, and this route means a
consumer no longer has to understand it to keep a smart list current.

→ `fixtures/operational.json`

### Bringing an object into being

```
PUT <base>/interchange/objects/<id>
```

```json
{ "type": "t_task", "properties": { "title": "Bleed the radiators" } }
```

**The client chooses the id.** Identity already says an id is opaque and
producer-assigned only by convention; nothing stopped a client from picking one,
and this is the verb that lets it. That single decision is what makes creation
idempotent, and idempotent creation is what an offline client needs more than it
needs anything else in this section: a queue that could not tell a retry from a
second create would answer a flaky network with duplicates, which is the one
failure a person notices immediately and cannot easily undo.

**A `PUT` at an id that already exists MUST NOT modify it.** It answers as
though the create succeeded, because it did succeed — once — and the client is
asking again only because it never heard so. Changing an object is `PATCH`'s
job. A `PUT` that replaced would discard every property the client had never
heard of, which is the round-trip rule broken at write time and by the verb
least likely to be suspected of it.

So the two writes divide cleanly, and neither can do the other's damage:

| | |
|---|---|
| `PUT .../objects/<id>` | make this exist. Never edits. Safe to repeat. |
| `PATCH .../objects/<id>` | change what exists. Never creates. `set`/`unset` only. |

The body is an object as the format describes one — `type`, `properties`,
`content`, `tags`. It MAY carry `id`; if it does, it MUST match the id in the
address, and a producer that finds them different MUST refuse rather than pick
one. Two ids in one request is a client bug, and guessing which was meant is how
an object is created somewhere nobody is looking for it.

`type` SHOULD name a type declared by the producer. A producer that accepts a
create naming a type it does not have MUST report the reduction rather than
inventing one silently — see *Every write answers for itself*.

Over HTTP: `201` when it was made, `200` when it already existed. Both are
success and a client is not required to tell them apart; the distinction is
there for the one that wants to know whether its retry was the one that landed.

→ `fixtures/create.json`

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

#### Tags

```json
{ "addTags": ["urgent"], "removeTags": ["someday"], "version": 7 }
```

Tags are not properties — they are a vocabulary shared across types, which is
why `set` cannot reach them and why replacing the list wholesale is the wrong
shape. A client that knows about one tag would send one tag and delete the rest,
which is the round-trip rule broken exactly as `set` would break it.

So: two moves, and the same rule as above. **A tag named by neither is
untouched.** Adding one already present changes nothing, removing one that is
absent changes nothing — both are successes, because a client replaying a queue
cannot know which of its writes landed and must be able to send the same thing
twice.

Tags compare byte-wise. A producer that folds case is welcome to; the format
does not, because two producers disagreeing about whether `Urgent` and `urgent`
are one tag is worse than either answer.

**The same tag in `addTags` and `removeTags` MUST be refused.** It has no
reading that is obviously right, and picking one silently is how a board ends up
tagged the opposite of what somebody asked for. Same argument as two ids on a
create.

If you version objects, a patch may carry `version`, and a stale one **MUST** be
refused rather than merged. Merging looks helpful and is how one client's edit
silently reverts another's, with the writer told it landed.

### A follower that also writes

Anything that mirrors you and changes you will meet its own writes coming back
down the feed. That is not a flaw in the feed; a change happened and the feed's
job is to say so. But a naive follower re-applies its own work forever, and the
obvious fix — *skip the changes I caused* — is a trap. Four rules make the echo
harmless instead, and they are cheaper than the trap.

#### Objects carry `version`

If you version objects, **a read MUST carry the version with each object**, not
just accept one on a write. A producer that demands `version` on a patch and
never issues one has made safe writing impossible through its own binding: the
only way to get the number is a private route, which is the thing a binding
exists to remove.

Opaque, like a cursor. Compare it for equality; do not parse it or order it.

#### A write answers with the result

The `object` and `cursor` in a write's answer — see *Every write answers for
itself* below — are what make the echo harmless. A client that applies the
returned object holds exactly what the producer holds, **including whatever the
producer did that the client did not ask for**, so the row that comes down the
feed afterwards carries a version it already has and there is nothing to do.

That is the load-bearing part, and the reason those two fields are not a
convenience.

#### Applying a change twice MUST be a no-op

An obligation on the consumer, and what makes any feed safe to follow. Versions
give you this for free: the echo carries the version you already have, so there
is nothing to do. Without it you compare content, which is slower and correct.

#### A creating client MAY choose the id

Ids are opaque to *consumers*, not unassignable by them. A client that names the
object it is creating gets idempotent creation: a retry after a timeout, and the
echo of its own create, both land on the id it already has instead of producing a
second object.

A producer that cannot honour a supplied id **MUST say so** rather than silently
assigning its own, because a client that believes it chose the id and did not
will duplicate every object it creates while offline.

#### On `origin`

A change row **MAY** name what caused it. It is useful for a human reading a log
and for a client that wants to know its write landed.

**It MUST NOT be used to decide whether to apply a change.** A write is not the
only thing a write does. In the reference implementation, completing a task
stamps a completion time the client never sent and spawns the next occurrence of
its series — a *new object*, on the same write. A follower skipping "its own"
changes discards the timestamp and never learns the next task exists. The echo
is not noise about something you already know; it is the producer telling you
what actually happened.

### Writing a placement

A patch changes an object's properties. Where an object *sits* is not one of its
properties — it belongs to the collection, which is where a read carries it — so
moving a card needs its own write:

```
PATCH <base>/interchange/collections/{collection}/members/{object}
{ "region": "do" }
{ "region": null }        ← still a member, no longer anywhere in particular
```

Same answer shape as any other write. `region` names a region the collection
declared; a name it did not declare **MUST** be refused rather than stored,
because a region nothing renders is a card that has vanished.

**Only for semantic placement.** A collection whose `placement.semantic` is false
is arranging furniture, and where a sticky note sits on a canvas is not a fact
another tool can use. There is no coordinate write in v0 and the omission is
deliberate: a format that can carry a judgment and a decoration in the same
message will be used to carry decorations.

### Every write answers for itself

```json
{ "ok": true, "fidelity": "full", "reports": [],
  "cursor": "1014", "object": { "id": "o_1", "version": 8, ... } }
```

```json
{ "ok": true, "fidelity": "reduced", "reports": ["series.anchor"] }
```

Loud failure, applied to writing. A server that stores what it can and answers a
bare `ok` has told the caller everything went in. `"fidelity": "full"` is a
promise, and it is worth something only because it is not said defensively —
report reduced on everything and the field stops carrying information.

`object` is the object as it now stands and `cursor` is where the write landed.
Both are optional and both are worth sending: they are what let a follower that
also writes recognise its own echo instead of trying to filter it out. A refusal
answers in the same shape — `ok: false`, with `conflict: true` for a stale
`version` — because "that region is not on this board" and "the network is down"
call for completely different things, and a caller that cannot tell them apart
will retry the one it should report.

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

## Known limits of v0

Three things a real library ran into that v0 does not solve, written down so
they are not rediscovered as bugs.

**`placement.semantic` is one flag for a whole collection.** A board can mix
regions that copy their meaning onto the objects entering them with regions that
keep it, and that is a per-region question. One flag is right often enough to
ship and wrong on a board built both ways.

**A sort key names one field, and some sorts name two.** "Alphabetical" in a
tool that lets a note go untitled means *the title, or the first line of the
body* — one key with a fallback. A sort key here names one field, so that
travels as the title alone and an untitled note sorts as missing rather than by
the words a person can actually see on the card. The producer reports it; a
consumer cannot repair it. A key that names an ordered list of fields, first
non-empty winning, is the smallest thing that would close it.

**A canvas holds things that are not objects.** Sticky notes with no id, and
connections drawn between them. They survive, as properties of the collection
that the round-trip rule carries — but nothing outside the producer can address
one, so no other tool can link to a note or state the connections as relations.
A canvas of drawn argument arrives as an opaque lump. Giving stickies ids would
fix it and would also make every canvas doodle a first-class object in everyone's
library, which is not obviously the better trade.

---

## Versioning

One integer in `format`. Additive changes do not bump it; the round-trip rule is what makes that safe.

## Checking yourself

```
npx pkm-check ./my-export.json        # where do I stand, and what next?
npx pkm-check --url https://app/api   # a running instance, read-only
npx pkm-check --self                  # the fixtures, against the reference implementation
```

Installing the checker installs this file and the fixtures with it, which is the
point: `AGENTS.md` is what you paste at your agent, and `fixtures/` is what tells
you whether it listened.

To measure your own implementation rather than a file, export the eleven operations
in `fixtures/README.md` and hand them to the runner:

```js
import { runSuites, levelsFrom } from "pkm-check/check/src/runner.js";
const results = runSuites(myAdapter, "node_modules/pkm-check/fixtures");
const { roles, byLevel } = levelsFrom(results);
console.log(roles);    // { produce: 2, consume: 1, operate: 0 } — never one number
```

The level that comes back is derived from the run, which is the whole point —
see *Levels*.

Paste the failures at your agent along with this file.
