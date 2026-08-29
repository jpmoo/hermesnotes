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

### There is no sort or grouping on a collection — closed

**Was:** `position` for explicit order and nothing else. Hermes kept sort and
grouping under `hermes:table_sort`, `hermes:view_state` and
`hermes:rollup_views` — this entry's own failure happening in the export, in the
namespace v0.1 was going to want. Talaria read those private keys to draw its
boards, which is the one thing the port existed not to do.

**Now:** `order` on the collection, beside `placement` and `membership`, holding
`sort` and `groupBy`.

There is no `mode` flag. `sort` present means the stored order is a snapshot;
absent, `position` is a decision somebody made by hand. The presence of the key
is the whole statement, which turns out to handle the awkward case exactly
right: Hermes has a saved sort that a user can switch off, and that state exports
as no `sort` with the producer's own copy intact under its prefix.

`by` is `{ field }`, `{ field, part }` or `{ meta }` rather than a bare string
with `type` reserved. Types are user data here — rows a person can rename — so a
field named `type` is a matter of time, and a reserved word costs a version bump
the day it arrives. Reusing the shape profile mappings already use meant `part`
came free, and `{ meta: "updated" }` gave Hermes' `edited` sort somewhere honest
to land instead of a fake field.

Two rules were worth writing down because every implementation decides them
silently and differently: **a missing value sorts last in both directions**, and
**ties fall through to `position`**. The first is what a person means by "sort by
due date, descending" — furthest-out first, undated out of the way, not a screen
of undated cards at the top. The second means a sort naming no tiebreak is still
stable, rather than depending on which pair the consumer's sort algorithm
happened to touch.

`{ meta: "type" }` groups by id and sorts by name. The two want different things
from one key and saying so is cheaper than letting each implementer pick.

**What it does not carry:** column widths, view modes, chip counts. The line is
the one `placement.semantic` already draws — sort and grouping change which
objects a person sees first, which is a decision; how wide a column is drawn is
furniture. And one genuine loss, reported rather than hidden: Hermes keeps an
arrangement per *view*, the format carries one per collection, so a collection
whose table and rollup disagree exports the one matching its kind and reports
`order.per-view-dropped`. The real library has exactly one of those — a rollup
whose 17 levels sort by due date while its top sorts alphabetically.

→ `fixtures/sort.json`

### There is no tag write — closed

**Was:** `tags` on an object when reading, and no way to change them. They are
not properties, so `set` could not reach them, and Talaria did `GET` then
`PUT /blocks/:id/tags` — two round trips against private routes.

**Now:** `addTags` and `removeTags` on the patch, which is the design this entry
already named as the smaller of the two options.

Named moves rather than a list, for the same reason `set` is not a whole-object
write: a client that knows about one tag would send one tag, and a producer
treating that as the new set deletes every tag the writer had never heard of.
That is the round-trip rule broken on the field most likely to be shared between
tools.

Adding one already present and removing one that is absent are both successes,
because a queue replaying after a lost answer cannot know which of its writes
landed. The same tag in both lists is refused — there is no reading of it that
is obviously right, and choosing one silently is how a board ends up tagged the
opposite of what somebody asked for.

The read-modify-write did not disappear; it moved into the producer, where it
has to be correct once instead of in every client that wants to add a tag. And
it now happens *after* the version check rather than before, which was a real
bug in the first draft: a stale patch was refused after the tags had already
changed, telling the caller nothing landed while something had.

→ `fixtures/tags.json`

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
