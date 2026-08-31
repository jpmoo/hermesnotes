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

Nothing outstanding that a real client has been blocked by. The three that
were here are below, with what each cost to answer; the one remaining piece of
unfinished business is named at the end of the first.

---

## Closed

### `derivations` named the feature and not the query — closed enough to say so

**Was:** `membership.mode: "query"` said *this list is computed* and nothing
about what computes it. The entry proposed two smaller moves in place of a
shared query language, and both have now happened.

**The first, already done:** the producer ships the evaluated set as the
snapshot the format permits beside `materialized: false`. That is what lets a
consumer render a smart collection it cannot recompute, and it is why Talaria
stopped asking Hermes to run queries for it.

**The second, now:** `GET /interchange/collections/{id}`, which answers with
that collection's membership evaluated at the moment it is asked.

**Why a cursor could not do this, which is the part worth keeping.** `since`
tells you what *changed*, and a computed membership changes without anything
changing: a task whose date falls into range today was not edited, so no feed
carries it and no cursor moves past it. A follower doing everything right — every
change absorbed, no event missed — still ends up holding a list that quietly
stopped being true. There was no way to ask. Now there is one.

**What it is deliberately not.** A shared query language. Understanding somebody
else's saved search and getting a fresh answer out of it are two problems, and
only the second is small: any producer with saved searches can run its own and
say what came back, while agreeing a language to express them in is a design
nobody has got right yet, where the wrong answer is worse than none. The query
still travels opaquely. What changed is that a consumer no longer has to
understand it to keep a list current.

The route carries the members as objects and their types, not a list of ids — a
consumer asks it precisely *because* it cannot run the query, so ids it has
nothing to resolve against would be an answer both current and unusable. That is
`collection.member-not-carried`.

**What is still open**, and is the honest remainder of this entry: the query
itself is still opaque, so a consumer cannot show a person *why* something is in
a list, or edit the rule. That needs a shared language and is a v0.2 question at
the earliest.

→ `fixtures/operational.json`

### A note identified by a date — closed

**Was:** nothing. "The note for 2026-08-25" was described here as a query, and
the format has no query language — so this looked like it had to wait for one.

**Now:** a `journal` profile, mapping `date` onto the field that holds the day.

**The entry had the wrong frame, which is why it sat open.** A daily note is not
a search. It is an object with a date identity — Obsidian's daily note, Logseq's
journal, Roam's daily note, Tana's day node — and calling it a query made a
shared query language a prerequisite for the most ordinary feature in the genre.
Profiles already exist to map a producer's own fields onto a shared vocabulary;
this needed no new machinery at all, only the right description.

Found by declaration and never by title. A note somebody named after a day is
not that day's page, and guessing from the shape of a title is how a tool starts
appending to somebody's meeting notes.

Duplicates are reported, not resolved. Producers create these lazily and one
that has raced with itself ends up with two pages for a date — Hermes has its
own version of this in `findOrCreateNote`. Choosing between them silently is how
the one with somebody's morning in it ends up behind the empty one.

**What it cost Hermes to say it, which is the useful part.** Hermes marks a
daily note with a `today_note` property that no type declared — so the date a
whole feature is built on travelled as an unexplained string, and a `journal`
mapping onto it would have been refused by the format's own rule that a mapping
must land. The exporter declares the field now. The same fault as the missing
`title` on text types, found the same way: by trying to say something true and
discovering the export could not.

→ `fixtures/journal.json`

### No hierarchy — closed

**Was:** nothing that says containment. `relations` gave an edge, `collections`
gave membership with `position`, and neither said "this block is the third
thing inside that one". Hermes' own rollup went out as `members: []` with the
structure smuggled inside a private property.

**Now:** `parent` and `position` on an object. A parent pointer and the same
opaque ordering token collections already use; an object with no parent is a
root.

No `children` array, deliberately. A list on the parent and a pointer on the
child are two statements of one fact, and the day they disagree there is no way
to tell which one is the document.

Three rules that are the whole of the design. A **cycle is invalid** — an object
that is its own ancestor describes no document and hangs anything that walks it.
A **parent that names nothing in this payload is not an error**, because a
`since` read is a delta and will routinely carry a child whose parent has not
changed; the object stands at the root until the parent turns up, and must
neither be dropped nor given an invented placeholder. And **flattening is
permitted and must be reported**: a consumer with no containment may draw a list
and still has to hand the tree back, or opening somebody's outline in the wrong
application destroys it.

**This is the entry that matters most, and not because outlines are important.**
Every other limit here arrived because Talaria needed something Hermes could not
say, which only ever surfaces gaps *both* of them feel. This one came from
asking what a different shape of application would need. Hermes does not
implement it and says so in `unsupported`, so the hierarchy cases are scoped
away when the suite measures Hermes and run against the reference instead.

The proof is `foreign`. The example library — a stranger's, from a producer that
is not Hermes — now contains an outline, and it round-trips through Hermes with
**234 leaves in and none lost**, on a feature Hermes cannot draw. A format that
only carried what its first producer happened to store would have dropped it.

→ `fixtures/hierarchy.json`

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

### A canvas could be read and not arranged — closed

**Was:** four separate holes, found the same way as everything else here — by
building a canvas surface in Talaria and discovering there was no way to write
what a canvas is made of.

Reading one was never the problem, and it is worth saying so: node geometry
travels as a member's `context`, sticky notes and connections travel as the
producer's own prefixed keys on the collection, and the round-trip rule carries
all of it. A consumer that strips the producer's prefix once at its seam has the
whole canvas. That half worked on the first try.

Writing had nothing. There was no coordinate write — deliberately, on the
reasoning that a format able to carry a judgment and a decoration in the same
message would be used to carry decorations. There was no way to add a member to
a collection or take one out, only to move one already there. There was no write
for a collection's own keys at all, which meant sticky notes and edges were
readable and unchangeable. And there was no search, so "find a block and put it
on the canvas" had no way to do the first half.

**Now:** four additions, one shape.

`PATCH .../collections/{c}/members/{o}` takes `context` as well as `region`, and
refuses whichever one the collection's `placement.semantic` says is wrong. That
is the correction to the original reasoning, and it is worth being precise about
what was wrong with it. The reasoning was right; the conclusion was too broad.
What protects the distinction between a judgment and a decoration is that the
collection declares which it holds and the write is refused against the wrong
one — not that one of the two is unwritable. Leaving it unwritable did not stop
anybody arranging a canvas. It meant every tool that arranged one did it through
a private route, which is precisely the outcome the rule existed to prevent.

`PUT` and `DELETE` at the same address make and unmake a membership, divided the
way `PUT` and `PATCH` are divided on an object and for the same reason: a repeat
must be recognisable as a repeat. `DELETE` unmakes the membership and leaves the
object alone, and removing something that is not there is a success, because a
replaying queue cannot know which of its writes landed.

`PATCH .../collections/{c}` writes the collection's own keys, prefixed only. This
is the one that took the most thought, because it is a bag-shaped write and those
are where implementations treat the payload as the whole object. `set`/`unset`,
a key named by neither untouched, and an unprefixed name refused — one rule that
covers the format's own structural keys without a list of exceptions, since they
are all unprefixed and each has rules a generic bag could not honour anyway.

`?q=` is a third narrowing on a read, and it inverts the rule the other two
follow. `since` and `profile` ignored give a client more than it asked for, which
is safe; `q` ignored gives a client the whole library labelled as matches, so a
producer that cannot search **MUST** refuse. Relevance order and no scores: a
ranking number from one producer means nothing beside another's, and a consumer
comparing two of them is comparing noise.

**What it cost:** sixteen fixture cases in a new suite, three adapter operations,
nine mutants, four routes. No new concepts — every one of these is a rule already
in the document applied to a door it had not been applied to.

**What is still not closed.** Sticky notes can now be written and still cannot be
addressed. They have no id anything outside the producer can name, so no tool can
link to one and the connections between them cannot be stated as relations. That
limit is in `AGENTS.md` under *Known limits of v0* and it stays there: giving
stickies ids would fix it and would also make every canvas doodle a first-class
object in everyone's library, which is not obviously the better trade. What has
changed is that the lump is now a lump you can put down as well as pick up.

→ `fixtures/membership.json`

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
