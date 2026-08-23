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

## Envelope

```json
{
  "format": "pkm-interchange/0",
  "producer": { "name": "hermes", "version": "2.1.0" },
  "conformance": {
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

---

## Versioning

One integer in `format`. Additive changes do not bump it; the round-trip rule is what makes that safe.

## Checking yourself

```
npx pkm-check ./my-export.json
```

Paste the failures at your agent along with this file.
