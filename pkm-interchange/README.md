# pkm-interchange

**A way for personal-knowledge apps to work with each other's data.**

Not a database, not a sync protocol, and not a schema you have to adopt. A small format your app can read and write, plus a checker that tells you how close you are.

```bash
npx pkm-check my-export.json                  # where do I stand, and what next?
npx pkm-check --url https://my-app/api        # check a running server, read-only
npx pkm-check --self                          # the whole suite, against a reference
```

---

## Why you would bother

It's easier to develop software than ever, and the PKM space is alive with hordes of new tools. You wrote a notes app, or a task app, or a canvas app. It works. It fits your head. The reason it fits your head is that you made every decision. That's also a potential obstacle to anyone else using it. And, likewise, you probably can't use any of the growing number of cool apps made by other folks without forking them and shoe-horning them into your practice and your data structure.

Export is one thing, and it's fine. Markdown has been a Godsend in that regard.

But we're talking interoperability. You self-host a block-based Notion-clone that someone else made. You made a great little app for Kanban boards that runs right on your laptop. It'd be great if those two apps shared info with one another so that your tasks weren't just transportable via export/import, but alive in both places — both apps working against the one store you already keep, rather than two copies trying to stay in step.

This spec describes a way for all of these apps to achieve interoperability without sacrificing any of the creativity, personalization, or fun.

### Your app becomes something other apps can talk to

Someone writes a kanban. Someone else writes a post-it widget. Someone else writes a review dashboard. None of them are a whole PKM, and none of them need to be. Each one is a single surface that works against **whatever the user already runs**, because all of them speak the same language.

And it's a language with a small, manageable vocabulary.

And it's a language that's structured for LLM coding agents to read.

Without this, a satellite app has to be written against one specific host's API, so it gets written once, for one app, by that app's author. There is no reason for that except the absence of a shared way for apps to ask one another: "What have you got, and what does it mean?"

Could you code up harnesses? MCP? Sure. But there's a better lesson to learn here. A GIF works all over the place because everything from your messaging app to your word processor knows what a GIF is all about. Not just to "File > Import" it, but to work with it as if it were native content.

A task. A calendar event. A contact. A note. This spec and its tools hope to make them behave the same way.

### Agents can work with your app without anybody writing an integration

An agent or secondary app that wants to complete a task in your primary to-do app currently needs to be told that your due date lives in `deadline`, that your tasks are `open`, `shipped`, or `dropped`, and that your project reference is an array. Somebody has to write that down, per app, and keep it current.

Here is a type — one kind of thing your app stores, described the way your app already thinks about it:

```json
{
  "id": "t_thing",
  "name": "Thing To Do",
  "fields": [
    { "key": "what", "kind": "text" },
    { "key": "deadline", "kind": "date" }
  ]
}
```

A stranger reading that learns your app holds things with two fields, one of them text and one of them a date. That is all. Which field is the *title* and which is the *due date* is a guess, and `deadline` only looks obvious because it is in English and you chose a helpful word. Rename it `d2` and nothing about the export gets worse — it was never readable in the first place.

So add three lines saying what those fields mean:

```json
{
  "id": "t_thing",
  "name": "Thing To Do",
  "fields": [
    { "key": "what", "kind": "text" },
    { "key": "deadline", "kind": "date" }
  ],
  "profiles": {
    "task": { "title": "what", "due": "deadline" }
  }
}
```

That reads: *this is a task; its title is in `what`, and its due date is in `deadline`.*

`task` is a word from a short shared list — `task`, `event`, `contact`, `note` — so an app that has never heard of you still knows what one is. Everything to the right of it is yours. Nothing was renamed, nothing moved, and `fields` is untouched. You added a translation, not a conversion.

Now any app that knows what a `task` is can find the title and due date of yours without knowing anything else about your app. If you go further and let it write, it can hand you back "this one is shipped" from its own store of tasks.

Your fields keep their own names. You didn't adopt anyone's schema.

The only thing that you did was explain what yours means.

### Data can outlive apps

You made a cool notes app, but now you want to try someone else's. That's fine and normal, and exporting your notes from one to the other can be an easy process or a hard one, depending on the situation.

If apps are actually talking to one another, we can do more than just use them to complement one another. We can walk from one to the other without skipping a beat. Your data flows among all of them rather than syncing from one to the next to the next, losing coherence or features along the way like a game of telephone.

### An app can be a waypoint rather than a terminus

The rule that makes all of the above work is that **data can pass through an app without being damaged**. Does your Eisenhower matrix app want to add additional information to a task so that it appears in the right quadrant? Does your canvas app need to keep information about edges and connections? It all works where it needs to, without altering the core of the task unless you want it to. Mark it complete in that canvas app — which is writing to the same store the rest of them read — and it shows up complete everywhere else, taking on whatever extra characteristics each of those apps wants to represent. Maybe completed tasks are shaded gray on your canvas, checked off on your task list, slid into another lane on a Kanban, or simply drop from an Eisenhower matrix altogether.

It all works the way each app wants it to.

---

## What it is, concretely

An app announces itself with a JSON document: the kind of data it is willing to share, and how much can be done with it — whether the app produces data, will consume data, and whether it will make changes to what it consumes and pump those back out.

```json
{
  "format": "pkm-interchange/0",
  "producer": { "name": "your-app", "version": "0.1.0" },
  "conformance": { "produce": 1, "consume": 0, "operate": 0,
                   "bindings": ["file"],
                   "profiles": ["task"], "features": [] },

  "types":       [ /* the kinds of thing you have, and what each one means */ ],
  "objects":     [ /* the things themselves */ ],
  "collections": [ /* lists, boards, canvases */ ],
  "series":      [ /* recurrence rules */ ],
  "relations":   [ /* links */ ]
}
```

An app doesn't need to deal in all of these different kinds of things. Types and objects are enough to get you started.

### One warning about that sample, because it trips everybody

The word `profiles` appears twice in this format, at two different heights, meaning two different things.

The one you just saw inside `conformance` is a **claim about scope**: "somewhere below, my types declare the `task` profile." Nothing consults it to read an object — it is not how a due date gets found. What it does is set what you are measured on: a checker asks a `task`-shaped question only of a producer that claimed `task`, so declaring narrowly is the mechanism working rather than a way of hiding.

The real thing lives **inside a type**, next to that type's `fields`, and it is the mapping from the previous section. Types are not filed under profiles. It is the other way round: a type carries its profiles the way a class carries the interfaces it implements.

```
envelope
├── conformance
│   └── profiles: ["task"]        ← a claim. "one of my types is a task."
└── types
    └── Thing To Do
        ├── fields                 ← what you store
        └── profiles               ← what it means
            └── task: { title: "what", due: "deadline" }
```

It reads top-down as though profiles outrank types because `conformance` is printed first. It doesn't. `conformance` is the label on the outside of the box.

Two rules everything else follows from, both worth reading twice:

1. **The data declares its own meaning.** A consumer must never need to know what your types are called. `if (type.name === "Task")` is a bug — in your code and in this format.
2. **A view never smuggles in meaning.** Where something sits on a canvas is not knowledge. Where it sits in an Eisenhower matrix is. You say which; a consumer cannot tell by looking.

The full specification is [`AGENTS.md`](AGENTS.md). It is written to be handed to a coding agent, and it takes about twenty minutes to read yourself.

---

## Who is the producer, and who is the consumer?

Not two apps having a conversation. They are **the two ends of one direction of data movement**. A producer writes a document; a consumer reads it. Nothing goes back, and nothing was asked for.

Below the top level, that is the whole protocol: *somebody hands you a document.* It might be a file on disk or a response from a URL — that part is only transport, and either way it moves one way and you send nothing back, because there is nothing to send it to. (The levels are a ladder, laid out in [Getting there](#getting-there-in-the-order-that-pays) below. All that matters here is that the top rung is the one with something live on the other end.)

Which is why one app is normally both. Your app is a producer when it exports, a consumer when it imports, and an operator when it serves a live API — three different jobs, which is why conformance carries three numbers instead of one. `produce: 2, consume: 1, operate: 0` is one app scored three times, not three apps.

### What a consumer receives, and what it does with it

One document. As a consumer, the parts you care about are `types` and `objects`: the objects hold the values, and the type each object points at tells you what those values mean.

```js
const type = typeById.get(object.type);
const task = type.profiles?.task;
if (!task) return;                          // no task profile? not a task. don't guess.

const title = object.properties[task.title];   // → "Ring the roofer"
const due   = object.properties[task.due];     // → "2026-09-01"
```

Two hops: the profile tells you which key to look under, then you look under it. That is the entire mechanism, and the rest of this document is details on top of it — compound fields, completion values, bodies that live outside the property bag.

Notice what never appears: `type.name`. You do not know or care that they call it a `Thing To Do`.

### What a consumer gives back is behaviour, not a message

There is no reply to send, but you are not off the hook. If that data ever leaves you again, the fields you never understood come back intact, and anything you could not keep, you say so out loud. Those are the two rungs above simply reading a file, and they are the obligations that make somebody else willing to point their library at you.

### Sending starts at level 4

Only the top rung has a counterpart that answers, and only there does a consumer transmit anything. What makes it level 4 is not that a network is involved — an export can be fetched over HTTP by an app that does nothing else — it is that you can ask it questions and change what it holds:

- **You send** a capability question — *before* writing, so you learn the limits instead of discovering them by breaking something — and partial writes: `{ "set": { "status": "done" }, "unset": ["owner"] }`.
- **You receive** the capabilities, the data, an answer for each write saying whether all of it landed, and a feed of what has changed since you last looked.

Same vocabulary as the file. Types, objects, profiles, placement, series, relations are the same words over HTTP or MCP as they are on disk — which is why level 4 is a *binding* and not a second format.

---

## A round trip, end to end

One producer, one consumer, five requests. The producer calls its things **Chores**: the title lives in `what`, the due date in `by`, and it considers `sorted` and `abandoned` to be finished. The consumer has never heard of any of that and never will.

Everything below is a transcript. `node walkthrough.mjs` in this folder runs it against a real server, so it cannot quietly stop being true.

### 1 · Ask what it can do

```
GET /conformance
```
```json
{ "produce": 4, "consume": 0, "operate": 4,
  "bindings": ["http"], "profiles": ["task"], "features": [] }
```

No credentials, deliberately. Deciding whether you can talk to something at all should not require an account — and an agent that has to attempt a write to learn whether writes exist has already done the damage if they do not.

`profiles: ["task"]` is the go/no-go. If it said `["contact"]` you would stop: this is an address book and you are a to-do list.

### 2 · Ask for the tasks

```
GET /interchange?profile=task
```
```json
{ "cursor": "40",
  "types":   [ { "id": "chore", "profiles": { "task": { ... } } } ],
  "objects": [ { "id": "o_7", "type": "chore", "version": 2,
                 "properties": { "what": "Bleed the radiators", "by": "2026-09-01",
                                 "state": "open", "faff": 7 } } ] }
```

Narrowing is permission to send less, never an obligation — a producer that finds filtering expensive should send everything rather than get it wrong. What it may **not** do is drop the types: an object whose type did not travel cannot be read at all, so the format makes that a rule rather than a courtesy.

Two things to notice in that payload. `version: 2`, which you will need to write. And `faff`, which is none of your business and is about to matter.

### 3 · Read it — no request, just arithmetic

```
profiles.task.title  = "what"   →  properties.what  = "Bleed the radiators"
profiles.task.due    = "by"     →  properties.by    = "2026-09-01"
profiles.task.status = "state"  →  properties.state = "open"
completeValues       = ["sorted", "abandoned"]
```

Is it done? **No** — `"open"` is not in that list.

Two hops: the profile says which key, then you look under that key. That is the entire mechanism. Notice what never happened — nobody read the type's *name*, and nobody guessed that a field called `by` might be a date. Both would have worked here and both are bugs, because the next producer calls it `d2`.

### 4 · Mark it done

```
PATCH /interchange/objects/o_7
```
```json
{ "set": { "state": "sorted" }, "version": 2 }
```
```json
{ "ok": true, "fidelity": "full", "reports": [], "cursor": "41",
  "object": { "version": 3,
              "properties": { "state": "sorted", "faff": 7,
                              "finished_on": "2026-08-25", ... } } }
```

Which value means *done* was the producer's to say, and it said so in `completeValues`. You took the first.

Two keys and no third: **`faff` is still 7.** A field this consumer knows nothing about, never mentioned, untouched. That is the round-trip rule at write time, and it is the half everybody skips — a tool can be scrupulous about an export and still destroy a field the moment an agent changes a title.

And `finished_on` appeared, which the producer stamped and nobody asked for. That is why a write answers with the object: apply what came back and you hold what the producer holds, side effects included.

### 5 · Try again with the version you started from

```json
{ "set": { "state": "open" }, "version": 2 }
```
```json
{ "ok": false, "conflict": true, "reports": ["version.stale"] }
```

Refused, not merged. Merging looks helpful and is how one client's edit silently reverts another's, with the writer told it landed.

### 6 · Catch up

```
GET /interchange?since=40
```
```json
{ "cursor": "41",
  "changes": [ { "object": "o_7", "op": "update" } ],
  "objects": [ { "id": "o_7", "version": 3, ... } ] }
```

Here you meet your own write coming back, and the tempting optimisation is to filter it out — *skip the changes I caused*. Don't. Look at what rode along with it: `finished_on`, which you never sent. In a real library the same write would also have created **the next occurrence of a repeating task** — a new object, attributed to you.

The echo is not noise about something you already know. It is the producer telling you what actually happened, and the answer is to make it harmless rather than absent: you already hold version 3 from step 4, so applying it changes nothing.

---

Five requests. The consumer never learned what a Chore is, and at no point needed to.

---

## What it models, and the five decisions that will surprise you

Types and objects are the easy part. Five things in here are opinionated, and they are the five an exporter runs into without warning.

### Recurrence is an object, not a field

A repeating task is not a task with a `repeat` property. It is a **series** — one rule, with its occurrences pointing at it.

That is not tidiness. A rule that advances from the *schedule* is a set generator: give it a start and it enumerates forever. A rule that advances from *completion* is a state machine waiting on something that has not happened, so only one future occurrence is ever knowable. They are different computations, so a format that stores both as a value lets a consumer import one as the other — and nothing in the imported data shows that it happened.

Monthly rules must also say `byMonthDay` and `monthEnd`. A rule on the 31st that clamps to 28 February must give 31 March next, and that is only computable if something remembers the 31.

### Placement is either a judgment or furniture, and only you know which

In storage the two cases are identical: an object holding a position in a collection. Nothing about the position itself says whether somebody decided it or whether it is where the card happened to land, so `placement.semantic` says which — and semantic placement uses **named regions, never coordinates**, because `urgent-important` survives being opened in a tool that draws no grid and `(340, 120)` does not.

A region can be a bare name or `{ name, label }` when the thing a machine matches on is not the words a person reads. That distinction earns its place: producers derive the name by slugging the label, so a format with nowhere to keep the label makes the derivation lossy — and a board arrives with regions a consumer can match on and cannot render, drawing "Region 3" over somebody's own words.

### A link is a link

`{ from, to }`, and `to` is required. Everything a reader might go on to ask — what kind of thing is it, does it still exist, what is it called — is a question about the far end and belongs to the far end. A copy of the target's type on the edge falsifies itself the moment the target is retyped.

A name written before the thing exists is not a link with a piece missing. It is a link to a **stub**: a real object with a real id, a name, and no type yet. When the stub becomes real it keeps its id, so every link already points at the right thing and nothing has to be rewritten.

### An address is a value, never a rule for making one

An object may carry `url`: an absolute address where a person can go to see it. A consumer treats it as opaque — it must not rewrite it, and it must not invent one for an object that arrived without.

The rejected design is the one everybody reaches for first. A single `urlTemplate` on the producer costs a handful of bytes instead of one string per object, and it is wrong: a consumer holding a template builds addresses by interpolating an id, for objects that never travelled and may not exist. The format promises ids are opaque, and everything else leans on that promise. A template quietly spends it, so a validator rejects one.

Emit an address if your app has a place a person can go. Emitting none is honest — the format reads it as "this producer does not publish addresses" rather than as an omission — while a guessed one is a link that sends somebody nowhere.

### Prose is opaque, and its links are mirrored

Most of the graph in a knowledge base is inside the writing — `[[wikilinks]]`, `@names`, whatever your editor does. The format standardises **no markup dialect**: yours comes back exactly as you wrote it. But every reference inside prose is also stated in `relations`, so a consumer that cannot parse your dialect still holds your graph, and one that is about to rewrite your prose can tell what it is about to break.

---

## Getting there, in the order that pays

Levels are a ladder. Each rung is a claim a checker can verify — and one you can lose. You are not expected to reach the top, and declaring honestly that you have not is the mechanism working, not an admission of failure.

| | claim | what it takes | what it buys |
|---|---|---|---|
| **0 · Readable** | a valid export | envelope, types, objects | someone can open it and see it |
| **1 · Legible** | declared profiles | profiles on your types | agents and other apps understand your data |
| **2 · Faithful** | round-trip | unknown fields survive a trip through you | people can safely try your app |
| **3 · Honest** | loud failure | report what you could not keep | people can trust the transfer |
| **4 · Operable** | a live surface | patch semantics, capability discovery, a change feed | other apps and agents can *work* in your app |

They are earned **per role** — producing, consuming, operating — because those are different jobs. Most apps in this genre can write a file and cannot read one. `produce: 2, consume: 1, operate: 0` is a normal and useful thing to say.

### Level 0 — one afternoon

Write your types and your objects into the envelope shape. Ids can be anything as long as they are unique within the export; nobody is allowed to parse them.

This is the same `Thing To Do` from the top of the page, with the rest of its fields filled in and one object to go with it — including `tags_i_use`, which is nobody's business but yours and travels anyway.

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

Value kinds are `text · richtext · number · boolean · url · date · datetime · datespan · enum · reference · attachment`, **and the list is open** — if you have a kind nobody standardised, declare it under your own name and it travels untouched.

The same goes for keys. Types, fields, collections, regions and the envelope itself are all open objects, and anything you hang on them survives a trip through somebody else's app. One rule: **unprefixed keys belong to the format, and yours go under a prefix you control** — `hermes:color`, not `color`. Two apps writing `color` at different meanings is one problem; the format later standardising `color` underneath everyone who got there first is the worse one.

One thing worth getting right at this stage, because it is the commonest shape in a knowledge base and the easiest to leave unsaid: **if a field can hold more than one value, say so.** One task in two projects, one note citing four sources.

```json
{ "key": "projects", "kind": "reference", "targetType": "t_project", "many": true }
```

It is checked in both directions — a `many` field holds a list, a field without it does not — so wrapping every reference in a one-element array and declaring no `many` fields is not a shortcut past the question. It fails, and it tells a consumer nothing either way.

Then ask where that leaves you — see [Checking yourself](#checking-yourself).

### Level 1 — the one to do even if you do nothing else

Add `profiles` to any type that is one of the four things a stranger can recognise: `task`, `event`, `contact`, `note`.

```json
"profiles": {
  "task": { "title": "what", "due": "deadline",
            "status": "state", "completeValues": ["shipped", "dropped"] }
}
```

A mapping has to land: whatever field it names must be one the type declares. Pointing `due` at a field that does not exist reads as a promise and hands a consumer back nothing, and it is the one way to hold level 1 while providing none of it — so the checker asks.

Some real shapes you might have:

**One field holding both ends of a span.** Map the halves:

```json
"profiles": {
  "task": { "title": "title",
            "start": { "field": "dates", "part": "start" },
            "due":   { "field": "dates", "part": "end" } }
}
```

**A body that is not a property** — a Markdown file with frontmatter, say. The object carries `content`, and the profile names it:

```json
"profiles": { "note": { "title": "title", "body": "content" } }
```

**A type that is two things at once.** A Meeting is an event to a calendar and a note to a notebook. Declare both; nobody has to be told which it "really" is.

**A type that is none of them.** Declare nothing. Absence is information: a Recipe with a `status` field whose options include `done` is *still not a task*, and a consumer that guesses will file your recipe box in someone's to-do list.

### Level 2 — the one everybody skips

**Any property you do not recognise must survive a round-trip byte-identical.**

This is the rule that makes the format worth anything, and it is the one that gets skipped because it feels like it is about somebody else's problem. It is about whether anyone can afford to try your app.

The trick is to **hold the original and overlay your model on top**, rather than decomposing an object into your own fields and reassembling one on the way out:

```js
// good: your model is a view over what you were given
const doc = structuredClone(incoming);
doc.objects.forEach(o => index(o));          // read what you understand
// ...later, when exporting: doc is still exactly what arrived, plus your edits

// bad: everything you did not have a column for is gone
const task = { id: o.id, title: o.properties.what, due: o.properties.deadline };
```

If your storage genuinely cannot hold an arbitrary blob, keep one — a JSON column per object called `carried`, or a side table — and put back what you took out. Reference implementation: [`check/src/reference.js`](check/src/reference.js).

The same rule applies **at write time**, which is where it is usually lost. If an agent changes one field, everything else must be untouched:

```json
{ "set": { "state": "shipped" }, "unset": ["owner"] }
```

Absent means absent. It never means delete.

### Level 3 — say what you dropped

When you cannot keep something, say so. Not an exception — an answer:

```json
{ "ok": true, "fidelity": "reduced", "reports": ["placement", "series.anchor"] }
```

The failure this prevents is silence. A task that recurs from its completion date imported as one that recurs from its schedule *looks right* and drifts, and the user finds out in March. Reporting it lets them decide.

Say `"full"` when you kept everything, and mean it. A tool that reports reduced fidelity defensively on every import has taught its users to ignore the report that mattered.

### Level 4 — if you have an API

Five things, all small, all covered in `AGENTS.md`:

- **Reads answer with an envelope** — the same document a file carries, so a client knows the shape before it asks. Optionally narrowed: `?profile=task` for one kind of thing, `?since=<cursor>` for what has moved. Narrowing is permission to send less, never permission to send objects nobody can read — the types always travel.
- **Partial writes** — `set` and `unset`, and nothing you were not told about changes.
- **Capabilities on request** — a client should be able to ask what you support *before* it writes, not discover by trying.
- **A change feed** where `op` describes the object, not the row that moved in your storage. A membership or a tag going away is an *update* to the object that had it. Get this wrong and dragging a card between two columns announces the card as deleted.
- **Moving something** is its own write, because where an object sits belongs to the collection rather than to the object: `PATCH .../collections/{c}/members/{o}` with a region *name*, refused if the collection never declared it.

If anything mirrors you **and** writes back, four more rules matter, and they are in `AGENTS.md` under *A follower that also writes*. The short version: a read must carry each object's `version` or nobody can write safely through your binding; a write should answer with the resulting object; applying the same change twice must do nothing; and a creating client may choose the id.

The tempting shortcut there — *let a follower skip the changes it caused* — is a trap, and the reason is worth reading before you build a sync loop.

---

## Checking yourself

Three ways, in order of how much setup they need.

### Ask where you stand

```bash
npx pkm-check my-export.json
```

Nothing to install, nothing to write. It answers the question people actually arrive with:

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

A rung, and one thing to do to reach the next. It scores **producing** only, because that is all a document can honestly show: a file cannot demonstrate that your app preserves what it did not understand, or that a partial write leaves the rest alone. Those are the next two sections.

### Check a running server

```bash
npx pkm-check --url https://my-app.example/api
npx pkm-check --url https://my-app.example/api --token "$KEY"
```

Asks what the instance claims, reads what it actually emits, and holds the two against each other — whether it declares the features its own data uses, whether anything it calls unsupported turns up anyway, whether its types say what they are, whether it reports what it could not express. **Read-only**, so it is safe to point at a live instance including somebody else's.

Without a token it checks the manifest and stops, because everything else is behind authentication and should be.

This is what most apps can be measured by, and it is honest about being narrower than the suite: most fixture cases are pure questions about data the case supplies — *given this type you have never seen, is this object finished* — and there is nowhere over a network to send one.

### Run the whole suite against your implementation

```bash
npx pkm-check --self       # 83 cases, four levels, against a reference implementation
```

To measure **your** app, implement the eleven operations below and hand them to the runner. This is an in-process check, so it wants your app to be JavaScript — if it is not, the fixtures are plain JSON and `fixtures/README.md` describes the case grammar, so a runner in your own language is a couple of hundred lines and a genuinely useful thing to contribute back:

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

Leave off anything you have not built. **Missing counts as failing**, deliberately: to somebody deciding whether to trust their notes to your app, "we have not built that" and "we built it wrong" are the same news.

Some cases come back **n/a** rather than passing or failing. Those are the ones that ask a consumer to behave as though it lacked something — no board, no query engine, no prose — which a reference implementation can pretend and a real one cannot. Asking an app with a matrix view to answer as though it had none tests nothing about that app. They are counted separately and reported next to the level, because an applicability rule is also the obvious way to dodge a suite.

The operations are described in [`fixtures/README.md`](fixtures/README.md). Each case carries a `why` explaining the failure it exists to prevent — when one goes red, read that before changing anything, because it usually describes a rule with untested neighbours.

**Derive your level from the run.** Do not write one down and hope. A manifest a producer writes is a promise; one that falls out of a suite is evidence.

---

## Working with an agent

This is what the format is shaped for, and `AGENTS.md` is written to be pasted whole.

1. Give your agent `AGENTS.md` and your app's data model.
2. Ask for an exporter. Run `npx pkm-check` on what it produces.
3. Paste the failures back, with the `why` from the fixture.
4. Repeat until the level stops moving, then decide whether the next rung is worth it.

The failures are specific and they explain themselves, which is what makes this loop work rather than turning into a guessing game.

---

## What this is not

Worth being clear so nobody builds on a promise that is not here.

- **Not sync.** Exchange, not concurrent editing. No merge, no conflict resolution, no live mirroring. `position` has no generation rule and there is no identity that correlates objects across producers.
- **Not a schema to adopt.** Your fields keep their names and your model keeps its shape. Profiles are a *mapping*, not a conversion.
- **Not complete.** v0 has known limits, written down rather than discovered as bugs. [`LIMITS.md`](LIMITS.md) is the honest list — seven gaps found by actually porting an app onto this, each with what the app does instead. `AGENTS.md` carries the ones inherent to the model: `placement.semantic` is one flag for a whole collection when a board can be built both ways, and a canvas's sticky notes have no ids anyone outside the producing app can address.

---

## Contributing

The most useful thing you can send is a **fixture that fails** — a case where two reasonable implementations would disagree, with a `why` saying what breaks. Four of the rules in the current spec exist because running a real library through an exporter hit a wall nobody had predicted.

The second most useful thing is a **second implementation**. Everything here is currently checked against one real app and one reference adapter, which is not enough to know whether the prose says what it thinks it says.

The name, the version and every decision in here are provisional. It is v0.

---

*This lives inside [Hermes Notes](https://github.com/jpmoo/hermesnotes) for now, next to the first app implementing it, so the spec and a real implementation can be held against each other. It has no dependency on Hermes and is meant to move out once there is a second.*
