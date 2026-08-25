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

**Meanwhile:** the membership arrives evaluated in the envelope already. It
goes stale, and there is no way to ask for a re-evaluation through the binding.

### No sort or grouping on a collection

**Needed for:** Talaria's matrix and table views, which sort within a region and
group by a property.

**What the format has:** `position` for explicit order, and nothing else.

**Why it matters:** the sort is a person's decision, held once and expected
everywhere — the same class of thing as a semantic region, and the format
already argues that class belongs in the data. A board that sorts by due date in
one app and by title in another is not the same board.

### A write costs a full export

**Needed for:** the write answer carrying the resulting object.

**What happens now:** `PATCH /interchange/objects/:id` reads the whole library
back to find one object, because the exporter derives relations and resolves
inline mentions across the entire set — running it on one block would resolve a
mention against a library of one and mint a stub with a fresh id.

**Why it is tolerable:** 111 objects, milliseconds, and correctness over
micro-optimisation. It will not stay tolerable. The fix is an exporter that can
take the whole set for context and emit a subset, which is the same shape
`narrow` wants and should replace it.

### There is no create

**Needed for:** Talaria making a task or a note.

**What the format has:** `set`/`unset` on an object that already exists, and
nothing that brings one into being. A creating client may choose the id — the
spec says so — which is most of what a create needs and not the verb itself.

**What Talaria does:** `POST /blocks` — a Hermes route. It is the largest
remaining hole in the port and the obvious next thing to specify: `PUT` an object
at the id the client picked, which makes creation idempotent by construction and
needs no new concepts.

### There is no tag write

**Needed for:** a matrix region that tags whatever enters it.

**What the format has:** `tags` on an object when reading, and no way to change
them. They are not properties, so `set` cannot reach them.

**What Talaria does:** `GET`/`PUT /blocks/:id/tags`. Either tags become
properties — which they are not, they are a shared vocabulary across types — or
the patch grows `addTags`/`removeTags`. The second is smaller and says what it
means.

### A note identified by a date

**Needed for:** appending a line to today's daily note.

**What the format has:** nothing. "The note for 2026-08-25" is a query, and the
format has no query language — the same gap as derivations, arriving from the
other direction.

**What Talaria does:** `GET /today/:date/note`. Worth noting that the daily note
is one of the most portable ideas in this genre and one of the least sayable
here.

### An object has no address

**Needed for:** clicking anything in Talaria.

**What the format has:** an `id`, opaque and unique within the export, and no
way at all to say where a human can go to see the thing.

**What Talaria does:** builds the URL itself — `{origin}/block/{id}`, or
`/collections/{id}` for a collection. That is Hermes' routing scheme, hardcoded
in the one place it could not be avoided, and it would send a person nowhere
against any other producer.

**Why it is worth specifying.** "Open this where it lives" is close to universal
and there is nothing to argue about: a producer knows its own URLs and nobody
else can guess them. A `url` on an object, or a template in `producer`, would
close it. Note the id must stay opaque either way — an address a producer hands
you is not a licence to construct another one.

---

## Closed

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
