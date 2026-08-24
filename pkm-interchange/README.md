# pkm-interchange

**A way for personal-knowledge apps to work with each other's data.**

Not a database, not a sync protocol, and not a schema you have to adopt. A small
format your app can read and write, plus a checker that tells you how far you
have got.

```bash
npx pkm-check my-export.json                  # where do I stand, and what next?
npx pkm-check --url https://my-app/api        # check a running server, read-only
npx pkm-check --self                          # the whole suite, against a reference
```

---

## Why you would bother

You wrote a notes app, or a task app, or a board. It works. It fits your head.
The reason it fits your head is that you made every decision yourself, and that
is also the reason nobody else can use it and it can use nothing else.

This format is a way out of that without giving any of it up.

### Your app becomes something other apps can talk to

Someone writes a kanban. Someone else writes a post-it widget. Someone else
writes a review dashboard. None of them are a whole PKM, and none of them need
to be — each one is a single surface that works against **whatever the user
already runs**, because all of them speak the same small vocabulary.

That is the thing that has never existed here. Today, a satellite app has to be
written against one specific host's API, so it gets written once, for one app,
by that app's author. There is no reason for that except the absence of a shared
way to ask "what have you got, and what does it mean?"

### Agents work with your app without anybody writing an integration

This is the payoff you get **before any second app exists**, which makes it the
one worth doing first.

An agent that wants to complete a task in your app currently needs to be told
that your due date lives in `deadline`, that your finished states are `shipped`
and `dropped`, and that your project reference is an array. Somebody has to write
that down, per app, and keep it current.

Declare a profile instead:

```json
{
  "id": "t_thing",
  "name": "Thing To Do",
  "fields": [
    { "key": "what", "kind": "text" },
    { "key": "deadline", "kind": "date" },
    { "key": "state", "kind": "enum", "options": ["open", "shipped", "dropped"] }
  ],
  "profiles": {
    "task": {
      "title": "what",
      "due": "deadline",
      "status": "state",
      "completeValues": ["shipped", "dropped"]
    }
  }
}
```

Now any agent that knows what a `task` is can find the title, the due date and
whether it is finished — in your app, without knowing anything about your app.
Your fields keep their own names. You did not adopt anyone's schema. You said
what yours means.

### Your users' data outlives your app

Weekend projects stop being maintained. That is fine and normal, and it is
usually the moment somebody's two years of notes go to die — exported as
Markdown, which keeps the words and loses which field was the due date, which
board position was a judgment, and which task was supposed to repeat.

An export in this format keeps the meaning, so the next tool can do something
with it beyond displaying paragraphs.

### You can be a waypoint rather than a terminus

The rule that makes all of the above work is that **data can pass through your
app without being damaged**. Someone tries your focus tool for a week, exports
back out, and the fields you never modelled are still there. That is the
difference between a tool people will try and a tool people will not risk.

---

## What it is, concretely

One JSON document. Everything in it is optional except saying what it is.

```json
{
  "format": "pkm-interchange/0",
  "producer": { "name": "your-app", "version": "0.1.0" },
  "conformance": { "produce": 1, "consume": 0, "operate": 0,
                   "bindings": ["file"],
                   "profiles": ["task"], "features": [] },

  "types":       [ /* what kinds of thing you have, and what they mean */ ],
  "objects":     [ /* the things */ ],
  "collections": [ /* lists, boards, canvases */ ],
  "series":      [ /* recurrence rules */ ],
  "relations":   [ /* links */ ]
}
```

An export with only `types` and `objects` is valid. Start there.

Two rules everything else follows from, both worth reading twice:

1. **The data declares its own meaning.** A consumer must never need to know what
   your types are called. `if (type.name === "Task")` is a bug — in your code and
   in this format.
2. **A view never smuggles in meaning.** Where something sits on a canvas is not
   knowledge. Where it sits in an Eisenhower matrix is. You say which; a consumer
   cannot tell by looking.

The full specification is [`AGENTS.md`](AGENTS.md). It is written to be handed to
a coding agent, and it takes about twenty minutes to read yourself.

---

## What it models, and the four decisions that will surprise you

Types and objects are the easy part. Four things in here are opinionated, and
they are the four an exporter runs into without warning.

### Recurrence is an object, not a field

A repeating task is not a task with a `repeat` property. It is a **series** — one
rule, with its occurrences pointing at it.

That is not tidiness. A rule that advances from the *schedule* is a set
generator: give it a start and it enumerates forever. A rule that advances from
*completion* is a state machine waiting on something that has not happened, so
only one future occurrence is ever knowable. They are different computations, so
a format that stores both as a value lets a consumer import one as the other —
and nothing in the imported data shows that it happened.

Monthly rules must also say `byMonthDay` and `monthEnd`. A rule on the 31st that
clamps to 28 February must give 31 March next, and that is only computable if
something remembers the 31.

### Placement is either a judgment or furniture, and only you know which

In storage the two cases are identical: an object holding a position in a
collection. Nothing about the position itself says whether somebody decided it or
whether it is where the card happened to land, so `placement.semantic` says
which — and semantic placement uses **named regions, never coordinates**, because
`urgent-important` survives being opened in a tool that draws no grid and
`(340, 120)` does not.

### A link is a link

`{ from, to }`, and `to` is required. Everything a reader might go on to ask —
what kind of thing is it, does it still exist, what is it called — is a question
about the far end and belongs to the far end. A copy of the target's type on the
edge falsifies itself the moment the target is retyped.

A name written before the thing exists is not a link with a piece missing. It is
a link to a **stub**: a real object with a real id, a name, and no type yet. When
the stub becomes real it keeps its id, so every link already points at the right
thing and nothing has to be rewritten.

### Prose is opaque, and its links are mirrored

Most of the graph in a knowledge base is inside the writing — `[[wikilinks]]`,
`@names`, whatever your editor does. The format standardises **no markup
dialect**: yours comes back exactly as you wrote it. But every reference inside
prose is also stated in `relations`, so a consumer that cannot parse your dialect
still holds your graph, and one that is about to rewrite your prose can tell what
it is about to break.

---

## Getting there, in the order that pays

Levels are a ladder. Each rung is a claim a checker can verify — and one you can
lose. You are not expected to reach the top, and declaring honestly that you have
not is the mechanism working, not an admission of failure.

| | claim | what it takes | what it buys |
|---|---|---|---|
| **0 · Readable** | a valid export | envelope, types, objects | someone can open it and see it |
| **1 · Legible** | declared profiles | profiles on your types | agents and other apps understand your data |
| **2 · Faithful** | round-trip | unknown fields survive a trip through you | people can safely try your app |
| **3 · Honest** | loud failure | report what you could not keep | people can trust the transfer |
| **4 · Operable** | a live surface | patch semantics, capability discovery, a change feed | other apps and agents can *work* in your app |

They are earned **per role** — producing, consuming, operating — because those
are different jobs. Most apps in this genre can write a file and cannot read one.
`produce: 2, consume: 1, operate: 0` is a normal and useful thing to say.

### Level 0 — one afternoon

Write your types and your objects into the envelope shape. Ids can be anything
as long as they are unique within the export; nobody is allowed to parse them.

```json
{
  "types": [
    { "id": "t_thing", "name": "Thing To Do",
      "fields": [
        { "key": "what", "kind": "text" },
        { "key": "deadline", "kind": "date" },
        { "key": "state", "kind": "enum", "options": ["open", "shipped", "dropped"] },
        { "key": "tags_i_use", "kind": "text" }
      ] }
  ],
  "objects": [
    { "id": "o_1", "type": "t_thing",
      "properties": { "what": "Ring the roofer", "deadline": "2026-09-01",
                      "state": "open", "tags_i_use": "house" },
      "created": "2026-08-01T09:00:00Z", "updated": "2026-08-20T11:00:00Z" }
  ]
}
```

Value kinds are `text · richtext · number · boolean · url · date · datetime ·
datespan · enum · reference · attachment`, **and the list is open** — if you have
a kind nobody standardised, declare it under your own name and it travels
untouched.

One thing worth getting right at this stage, because it is the commonest shape
in a knowledge base and the easiest to leave unsaid: **if a field can hold more
than one value, say so.** One task in two projects, one note citing four sources.

```json
{ "key": "projects", "kind": "reference", "targetType": "t_project", "many": true }
```

It is checked in both directions — a `many` field holds a list, a field without
it does not — so wrapping every reference in a one-element array and declaring
no `many` fields is not a shortcut past the question. It fails, and it tells a
consumer nothing either way.

Then ask where that leaves you — see [Checking yourself](#checking-yourself).

### Level 1 — the one to do even if you do nothing else

Add `profiles` to any type that is one of the four things a stranger can
recognise: `task`, `event`, `contact`, `note`.

```json
"profiles": {
  "task": { "title": "what", "due": "deadline",
            "status": "state", "completeValues": ["shipped", "dropped"] }
}
```

A mapping has to land: whatever field it names must be one the type declares.
Pointing `due` at a field that does not exist reads as a promise and hands a
consumer back nothing, and it is the one way to hold level 1 while providing
none of it — so the checker asks.

Some real shapes you might have:

**One field holding both ends of a span.** Map the halves:

```json
"profiles": {
  "task": { "title": "title",
            "start": { "field": "dates", "part": "start" },
            "due":   { "field": "dates", "part": "end" } }
}
```

**A body that is not a property** — a Markdown file with frontmatter, say. The
object carries `content`, and the profile names it:

```json
"profiles": { "note": { "title": "title", "body": "content" } }
```

**A type that is two things at once.** A Meeting is an event to a calendar and a
note to a notebook. Declare both; nobody has to be told which it "really" is.

**A type that is none of them.** Declare nothing. Absence is information: a
Recipe with a `status` field whose options include `done` is *still not a task*,
and a consumer that guesses will file your recipe box in someone's to-do list.

### Level 2 — the one everybody skips

**Any property you do not recognise must survive a round-trip byte-identical.**

This is the rule that makes the format worth anything, and it is the one that
gets skipped because it feels like it is about somebody else's problem. It is
about whether anyone can afford to try your app.

The trick is to **hold the original and overlay your model on top**, rather than
decomposing an object into your own fields and reassembling one on the way out:

```js
// good: your model is a view over what you were given
const doc = structuredClone(incoming);
doc.objects.forEach(o => index(o));          // read what you understand
// ...later, when exporting: doc is still exactly what arrived, plus your edits

// bad: everything you did not have a column for is gone
const task = { id: o.id, title: o.properties.what, due: o.properties.deadline };
```

If your storage genuinely cannot hold an arbitrary blob, keep one — a JSON column
per object called `carried`, or a side table — and put back what you took out.
Reference implementation: [`check/src/reference.js`](check/src/reference.js).

The same rule applies **at write time**, which is where it is usually lost. If an
agent changes one field, everything else must be untouched:

```json
{ "set": { "state": "shipped" }, "unset": ["owner"] }
```

Absent means absent. It never means delete.

### Level 3 — say what you dropped

When you cannot keep something, say so. Not an exception — an answer:

```json
{ "ok": true, "fidelity": "reduced", "reports": ["placement", "series.anchor"] }
```

The failure this prevents is silence. A task that recurs from its completion
date imported as one that recurs from its schedule *looks right* and drifts, and
the user finds out in March. Reporting it lets them decide.

Say `"full"` when you kept everything, and mean it. A tool that reports reduced
fidelity defensively on every import has taught its users to ignore the report
that mattered.

### Level 4 — if you have an API

Three things, all small, all covered in `AGENTS.md`:

- **Partial writes** — `set` and `unset`, and nothing you were not told about
  changes.
- **Capabilities on request** — a client should be able to ask what you support
  *before* it writes, not discover by trying.
- **A change feed** where `op` describes the object, not the row that moved in
  your storage. A membership or a tag going away is an *update* to the object
  that had it. Get this wrong and dragging a card between two columns announces
  the card as deleted.

---

## Checking yourself

Three ways, in order of how much setup they need.

### Ask where you stand

```bash
npx pkm-check my-export.json
```

Nothing to install, nothing to write. It answers the question people actually
arrive with:

```
my-export.json

  ok    well-formed
        no rule broken
  ok    has something in it
        1 type(s), 1 object(s)
  FAIL  types say what they are
        none — a consumer has to guess which field is a due date
  FAIL  says what it could not express
        nothing reported

  produce: level 0
  consume and operate are not visible in a file — see --url or the suite

Next: Declare a profile on at least one type — `task`, `event`, `contact`
or `note` — mapping your own field names onto it. That is level 1, and it
is the rung that makes agents and other apps able to read your data. See
"Level 1" in the README.
```

A rung, and one thing to do to reach the next. It scores **producing** only,
because that is all a document can honestly show: a file cannot demonstrate that
your app preserves what it did not understand, or that a partial write leaves the
rest alone. Those are the next two sections.

### Check a running server

```bash
npx pkm-check --url https://my-app.example/api
npx pkm-check --url https://my-app.example/api --token "$KEY"
```

Asks what the instance claims, reads what it actually emits, and holds the two
against each other — whether it declares the features its own data uses, whether
anything it calls unsupported turns up anyway, whether its types say what they
are, whether it reports what it could not express. **Read-only**, so it is safe
to point at a live instance including somebody else's.

Without a token it checks the manifest and stops, because everything else is
behind authentication and should be.

This is what most apps can be measured by, and it is honest about being narrower
than the suite: most fixture cases are pure questions about data the case
supplies — *given this type you have never seen, is this object finished* — and
there is nowhere over a network to send one.

### Run the whole suite against your implementation

```bash
npx pkm-check --self       # 66 cases, four levels, against a reference implementation
```

To measure **your** app, implement the ten operations below and hand them to the
runner. This is an in-process check, so it wants your app to be JavaScript — if
it is not, the fixtures are plain JSON and `fixtures/README.md` describes the
case grammar, so a runner in your own language is a couple of hundred lines and
a genuinely useful thing to contribute back:

```js
import { runSuites, levelsFrom } from "pkm-check/check/src/runner.js";

const myAdapter = {
  validate, profilesOf, read, isComplete, order,
  nextOccurrence, import: importFn, roundtrip, patch, follow,
};
const results = runSuites(myAdapter, "node_modules/pkm-check/fixtures");
const { roles, byLevel } = levelsFrom(results);
console.log(roles);     // { produce: 2, consume: 1, operate: 0 }
console.log(byLevel);   // { 1: { passed: 20, failed: 3, na: 0 }, ... }
```

Leave off anything you have not built. **Missing counts as failing**, deliberately:
to somebody deciding whether to trust their notes to your app, "we have not built
that" and "we built it wrong" are the same news.

Some cases come back **n/a** rather than passing or failing. Those are the ones
that ask a consumer to behave as though it lacked something — no board, no query
engine, no prose — which a reference implementation can pretend and a real one
cannot. Asking an app with a matrix view to answer as though it had none tests
nothing about that app. They are counted separately and reported next to the
level, because an applicability rule is also the obvious way to dodge a suite.

The operations are described in [`fixtures/README.md`](fixtures/README.md). Each
case carries a `why` explaining the failure it exists to prevent — when one goes
red, read that before changing anything, because it usually describes a rule with
untested neighbours.

**Derive your level from the run.** Do not write one down and hope. A manifest a
producer writes is a promise; one that falls out of a suite is evidence.

---

## Working with an agent

This is what the format is shaped for, and `AGENTS.md` is written to be pasted
whole.

1. Give your agent `AGENTS.md` and your app's data model.
2. Ask for an exporter. Run `npx pkm-check` on what it produces.
3. Paste the failures back, with the `why` from the fixture.
4. Repeat until the level stops moving, then decide whether the next rung is
   worth it.

The failures are specific and they explain themselves, which is what makes this
loop work rather than turning into a guessing game.

---

## What this is not

Worth being clear so nobody builds on a promise that is not here.

- **Not sync.** Exchange, not concurrent editing. No merge, no conflict
  resolution, no live mirroring. `position` has no generation rule and there is
  no identity that correlates objects across producers.
- **Not a schema to adopt.** Your fields keep their names and your model keeps
  its shape. Profiles are a *mapping*, not a conversion.
- **Not complete.** v0 has known limits, written down in `AGENTS.md` rather than
  discovered as bugs: `placement.semantic` is one flag for a whole collection
  when a board can be built both ways, and a canvas's sticky notes have no ids
  anyone outside the producing app can address.

---

## Contributing

The most useful thing you can send is a **fixture that fails** — a case where
two reasonable implementations would disagree, with a `why` saying what breaks.
Four of the rules in the current spec exist because running a real library
through an exporter hit a wall nobody had predicted.

The second most useful thing is a **second implementation**. Everything here is
currently checked against one real app and one reference adapter, which is not
enough to know whether the prose says what it thinks it says.

The name, the version and every decision in here are provisional. It is v0.

---

*This lives inside [Hermes Notes](https://github.com/jpmoo/hermesnotes) for now,
next to the first app implementing it, so the spec and a real implementation can
be held against each other. It has no dependency on Hermes and is meant to move
out once there is a second.*
