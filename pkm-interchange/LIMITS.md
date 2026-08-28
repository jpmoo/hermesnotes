# What the format could not carry

Kept while porting Talaria from Hermes' private routes onto the interchange
binding — the first time any app has tried to live entirely on this format.

Each entry is something a real client needed and the format had no way to say.
That is the point of writing them down: v0 is small on purpose, and the way to
find out what v0.1 owes people is to build something on v0 and keep a list
rather than quietly reaching past it.

**A limit is not a bug.** Reaching past the format to Hermes for one of these is
the honest move for now, as long as it is here, named, and confined to a place
somebody can find. What is not acceptable is reaching past it silently.

**And a list built this way has a bias worth stating.** One consumer was ported
onto one producer, so this finds what *both* of them feel and is blind to
everything neither does. Hermes is flat blocks plus collections; nothing here
would ever have noticed that the format cannot express an outline, which is the
native shape of Logseq, Roam, Tana and Workflowy. That entry is below, and it is
marked as found by asking rather than by building — the two kinds of evidence
are not equally strong and should not read as though they are.

The test this file exists to serve is not *can Talaria talk to Hermes*. It is
*can two applications that have never heard of each other exchange a library*.
Those come apart quietly: an entry that names a shared need reads exactly like
an entry that names a Hermes need, and only the second one narrows the format
into an API for one product.

---

## Open

### `derivations` names the feature and not the query

**Needed for:** smart collections. Talaria asks Hermes which blocks a saved
filter matches (`POST /blocks/query`), because the filter language — types,
tags, properties, relative dates, nested groups — is Hermes'.

**What the format has:** `membership.mode: "query"` on a collection, which says
*this list is computed* and nothing about what computes it.

**Why it is not obviously fixable:** a shared query language is a large piece of
design, and the wrong one is worse than none. Two smaller moves would carry most
of the value: let a producer ship the *evaluated membership* alongside the
declaration, so a consumer can render a smart list it cannot recompute; or let
the query travel opaquely with a named dialect, so a consumer knows to ask the
producer rather than guess.

**Meanwhile:** the producer ships the evaluated set as the snapshot the format
already allows beside `materialized: false` — the query stays the truth, the
members are a courtesy, and a consumer must not treat them as authoritative.
That is enough to *render* a smart collection without a query engine, which is
what a consumer actually needs, and it is why Talaria no longer asks Hermes to
run the query.

This sentence used to claim the membership already arrived evaluated. It did
not: Hermes shipped `members: []` on every dynamic smart collection, and
Talaria reached past the binding to `POST /blocks/query` for all of them. The
line made the limit sound smaller than it was, which is the worst thing a
limitations document can do.

**What is still missing:** a way to ask for a re-evaluation through the binding.
A snapshot is as fresh as the last export, which for a polling consumer is
fine, and for one that has just written something is not.

### No sort or grouping on a collection

**Needed for:** Talaria's matrix and table views, which sort within a region and
group by a property.

**What the format has:** `position` for explicit order, and nothing else.

**Why it matters:** the sort is a person's decision, held once and expected
everywhere — the same class of thing as a semantic region, and the format
already argues that class belongs in the data. A board that sorts by due date in
one app and by title in another is not the same board.

### There is no tag write

**Needed for:** a matrix region that tags whatever enters it.

**What the format has:** `tags` on an object when reading, and no way to change
them. They are not properties, so `set` cannot reach them.

**What Talaria does:** `GET`/`PUT /blocks/:id/tags`. Either tags become
properties — which they are not, they are a shared vocabulary across types — or
the patch grows `addTags`/`removeTags`. The second is smaller and says what it
means.

### No hierarchy

**Needed for:** any outliner. Logseq, Roam, Tana and Workflowy are outline-first
— a block sits *inside* another block, in order, and the nesting is the document
rather than a view of it.

**What the format has:** nothing that says containment. `relations` gives an
edge, `collections` give membership with `position`, and neither says "this
block is the third child of that one". A tree can be approximated with reference
fields, which is what Hermes does, and an approximation is what it stays: the
edges are there and the order and the containment are not.

**How this one was found, which is the part worth keeping:** not by porting.
Every other entry in this file arrived because Talaria needed something and
Hermes could not say it — and that only ever surfaces gaps *both* of them feel.
Hermes is flat blocks plus collections, so neither would ever notice this one.
It came from asking what a different shape of application would need, and the
answer is a large fraction of the genre.

**The evidence is in Hermes' own export.** A rollup — its one hierarchical
collection — goes out as `members: []` with the whole structure inside a
`rollup` property. The hierarchy is not expressed, it is smuggled, and a
consumer gets a collection it knows is a rollup and cannot draw.

### A note identified by a date

**Needed for:** appending a line to today's daily note.

**What the format has:** nothing. "The note for 2026-08-25" is a query, and the
format has no query language — the same gap as derivations, arriving from the
other direction.

**What Talaria does:** `GET /today/:date/note`. Worth noting that the daily note
is one of the most portable ideas in this genre and one of the least sayable
here.

---

## Closed

### There is no create — closed

**Was:** `set`/`unset` on an object that already exists, and nothing that brings
one into being. Talaria made every task and note with `POST /blocks`, a Hermes
route, which was the largest remaining hole in the port.

**What the format has now:** `PUT <base>/interchange/objects/<id>`. The client
chooses the id, which Identity always permitted and no verb ever used — and
which is the whole mechanism rather than a detail, because an id decided before
the request is what makes a repeat recognisable as a repeat. A queue that could
not tell a retry from a second create would answer a flaky network with
duplicates.

It creates and never edits. A `PUT` at an id already taken answers as a success
that changed nothing, because a replace would discard every property the caller
had never heard of — the round-trip rule broken at write time, by the verb least
likely to be suspected of it. Changing an object stays `PATCH`'s job, where
absent already means absent.

**What it cost:** no new concepts. Seven fixture cases, one adapter operation,
one route. The design had been written down in this file for weeks; what it was
waiting for was a client that needed it, which is the whole reason this file
exists rather than a v0.1 wishlist.

### A write costs a full export — not a format limit

Kept, moved, because it does not belong in Open and deleting it would lose the
reasoning.

`PATCH` and `PUT` both read the whole library back to find one object, because
the exporter derives relations and resolves inline mentions across the entire
set — running it on one block would resolve a mention against a library of one
and mint a stub with a fresh id. 143 objects, milliseconds, correctness over
micro-optimisation, and it will not stay tolerable.

**Why it is not a limit of the format.** This file's own rule is that an entry
is *something a real client needed and the format had no way to say*. The format
says the write answer perfectly well — `object`, `cursor`, `fidelity`. Hermes is
merely slow at producing one. Filed here it inflated the count of format gaps
with a producer's engineering task, which is the same category error as a
producer's key spending a name the format owns.

The fix is Hermes': an exporter that takes the whole set for context and emits a
subset, which is the shape `narrow` wants and should replace it.

### External feeds were never a gap

**Was:** calendar events Talaria shows from subscribed ICS feeds have no place in
the format, and a consumer rendering a calendar has to get them somewhere — so
today it asks Hermes.

**Why it is not a gap.** An ICS feed is a URL that anybody can fetch. Two apps
subscribed to the same calendar do not need one of them to relay it to the
other; they need the same URL. Nothing about the events is *the producer's* —
they are a third party's, read-only, and identical whoever asked.

The reason it looked like one is that Talaria happened to ask Hermes first, and
a route you are already calling is easy to mistake for a dependency you have.
That is worth remembering next time something appears to be missing from the
format: check whether the data is the producer's to give before asking the
format to carry it.

**What follows:** `GET /calendar/events` is a Hermes call Talaria does not need.
Talaria can hold its own feed list and fetch the same URLs. Not yet done — it is
a feature rather than a fix, and Hermes' own ICS reader is 399 lines of the
kind that recurrence rules and timezones make long.
