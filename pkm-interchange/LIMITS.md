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

One, found 2026-10-24 by the third client: Talaris, building an entity store
of its own — people, events, notes — on the format rather than on Hermes. Its
companion, `contact` and `event` without slots, is closed below.

### A mention in `content` cannot say where it was found

**Found by building, and by the checker.** A profile may map onto `content` —
the reserved body slot — and the validator allows it
(`profile.field-not-declared` skips `content`). But an inline mention must name
the field it was found in, and that field must be one the type declares
(`inline.field-not-declared`); `content` is not declared, so a mention in a
body kept there has nowhere to point. The fixtures avoid it by declaring
`body` as a field. Talaris now does the same; a producer keeping bodies where
the format reserves room for them would fail validation for following the
format.

**What would close it:** `content` accepted as the `field` of an inline
relation, as it already is as a profile target — one line in the validator,
one sentence in *Inline references*, one fixture case.

---

## Closed

Below, with what each cost to answer. Several carry a remainder — the part that
was not closed with the rest — and each says so at its own end rather than
here. No count: the one that used to be in this spot drifted from three to ten
without anybody noticing, which is what a number in prose does.

### An object could not be archived over the live binding — closed

**Was:** `archived` was read on every object and written by none. `PATCH`
carried properties, tags and the body, and had no word for filing something
away or bringing it back. A Talaris–Hermes sync could see that one side had
archived a task and could not say so to the other, so it left the pair alone:
three tasks archived in Hermes Notes stayed open in Talaris's inbox.

**Now:** a patch may carry `archived`, a boolean, beside `set`; untouched when
not named; refused with the rest of a stale patch. Four cases in
`fixtures/archive.json`, four mutants caught.

**Additive, so `format` does not bump.** A client that never names it changes
nothing it did not change before.

→ `fixtures/archive.json`

### A task could not say where its notes were — closed

**Was:** `event`, `contact`, `note` and `project` each had a `body`; `task`
did not. Every task tool keeps words on a task, and no two call the field the
same: Hermes' Task keeps them in `notes`, Talaris's in `description`. With no
slot to say so, the Talaris–Hermes sync carried a task's name, status, dates
and project and left its notes where they were typed — found when a
description written in Talaris never reached Hermes.

**Now:** `task` has `body`, read as every other profile's: a field, or
`content`. One case in `fixtures/profile.json`. Hermes' type editor offers it
as the task's Notes; Talaris's Task declares its `description`.

**Additive, so `format` does not bump.** A producer that does not declare it
says it has no notes to carry, which is what its silence said before.

→ `fixtures/profile.json` (`profile/a-task-says-where-its-notes-are`)

### A status could say finished and nothing else — closed

**Found by building, 2026-10-25:** the Hermes sync in Talaris. The task
profile's one status rule was `completeValues`, so the only meaning two tools
could share was *finished or not*. Talaris's "in progress" had no way to find
Hermes Notes' equivalent, so a sync could carry nothing between two open
statuses; and Talaris counts "won't do" as finished, so a task somebody
dropped arrived in Hermes Notes as one that was done.

**Now:** `states` on the task profile, each status option mapped onto one of
five — `not-started`, `in-progress`, `waiting`, `done`, `cancelled`. The names
stay each producer's own; only what they mean is shared. A consumer reads
`state` through the profile and carries a status as the other tool's first
option of the same state. Three rules: an option of the status field, one of
the five, and `done`/`cancelled` exactly the options in `completeValues`. An
option given no state is undeclared, and a consumer must not guess one from
its name.

**Why five, and these.** Every task tool met so far — a todo list, a kanban,
Hermes, Talaris, an outliner with TODO/DOING/DONE — has some of these and none
with a sixth that the others lack a word for. "Waiting" is the one a plain list
has no column for, and the one a person most wants to keep when a task moves.
A vocabulary large enough to say everything is one no two tools map onto alike.

**Additive:** `completeValues` keeps its meaning and its job; a consumer that
never heard of `states` reads finished exactly as before.

**What it asks of a sync**, said here because it is the reason for the entry:
a status travels only once both sides have given every option a state, and
until then the sync carries nothing about it rather than guessing.

→ `fixtures/profile.json`

### A body could be created and never changed — closed

**Found by building, 2026-10-25:** the Hermes sync plugin in Talaris, adding
notes. Hermes keeps a note's words where the format reserves room for them —
its Text type maps `note.body` onto `content` — and a `PATCH` was `set`/`unset`
over properties and nothing else. So a note could be made with its words
through `PUT` and its words could never change: a sync would copy each note
once and let the two copies drift apart, saying nothing. The read half had the
body all along; the write half had no way to reach it.

**Now:** `content` on the patch, beside `set` — not inside it, because a type
may declare a field called `content` and that is a property like any other. It
replaces the body whole; `unset: ["content"]` removes it; a patch that does not
name it leaves it alone; a stale `version` refuses it with everything else. A
producer that keeps no body says `content.not-kept` rather than answering `ok`
for words it dropped.

**Not a Hermes-shaped answer.** Talaris keeps a note's words in a file, Obsidian
in a file, Logseq in blocks, Hermes in a block's content: the body slot exists
because so many tools keep the body apart from the fields, and a format that
let a client read it and not write it would have been a read-only format for
the one thing most of these tools are for.

→ `fixtures/content.json`

### An attachment could be carried and not handed over — closed

**Found by building, 2026-10-25,** by the same sync, and already named as the
remainder of *An attachment could be named and not carried*: a live client had
no way to give a producer a file, or take one, except inside a whole export as
base64. A sync keeping a task's attachments in step needs both, one file at a
time, and needs a removal on one side to be a removal on the other.

**Now:** *Files*, under *The live binding*. `PUT`, `GET` and `HEAD` at
`/interchange/files/<sha256>`, raw bytes, the hash as the address and checked
(`file.hash-mismatch`), a repeat put a success, an unknown file `file.not-held`
rather than an empty body. Attaching and removing are patches of the attachment
field, so they ride everything a patch already has — versions, answers, the
feed. A hash the producer does not hold is a known-missing file, said.

**Deliberately no `DELETE`.** A client that could delete a file by its hash
could delete one another object still holds. Removing an attachment is taking
it out of the field; a file nothing names any more is the producer's to free.

**Additive:** declared as `attachment-files`; a consumer that never heard of it
reads hashes, as it already did.

→ `fixtures/files.json`

### `contact` and `event` named a profile and almost no slots — closed, and `project` with them

**Was:** `task` said what its slots were; `contact` and `event` were names on
the v0 list with nothing under them beyond what a fixture happened to show.
Talaris's Person mapped `title`, `email` and `phone` and its Event `title`,
`start`, `end` and `location` — guesses at a vocabulary, which is what the
format exists to prevent. And there was no way at all to say *this is a
project*: Hermes keeps a `project` profile of its own and, failing that, finds
projects by a type called Project — the guess this codebase otherwise forbids,
kept "until declaring is the norm".

**Now:** every v0 profile's slots are a table in *Profiles*. `contact` is
`title`, `email`, `phone`, `organization`, `role`, `body`; `event` is `title`,
`start`, `end`, `location`, `attendees`, `organizer`, `body`; `project` joins
the vocabulary with `title` and `body`; and `task` gains `project`. The three
slots that point at other things — a task's project, a meeting's attendees and
organizer — must name a `reference` (`profile.slot-not-a-reference`), because a
name in a text field cannot be followed. Five cases in `fixtures/profile.json`
and a mutant that lets a text field through.

**Why now, and why it is not a Hermes-shaped answer.** What forced it was a
sync: a Talaris plugin keeping tasks, projects, events and people in step with
Hermes, which cannot find a person or a meeting on either side without being
told which type is which and which field is the address. But the slots are the
ones both clients already had, and the ones any address book or calendar has —
`organization` is a text field *or* a reference precisely because Hermes keeps
organizations as things and an address book keeps them as words. `role` came
in because both stores carry it; a slot only one of them wanted would have
stayed out.

**Additive, so `format` does not bump.** A consumer that knows only the old
vocabulary reads `project` as an unknown profile and carries it, which is what
it was already obliged to do.

**What is still open:** nothing in the format says that a task's `project` and
a project's tasks are the same fact seen from two ends — it is one reference,
read either way, as every reference already is. And a producer whose projects
are only collections has collections, not projects; *Profiles* says so rather
than stretching `project` to cover both.

→ `fixtures/profile.json`

### An attachment could be named and not carried — closed

**Was:** the format had an `attachment` value kind carrying a file name and
nothing else. A name is enough to *describe* an attachment and not enough to
*move* one, so a consumer holding a file could only say "there is one, called
this" — true, and useless to anybody who did not already have the file.

**Now:** the value carries its own identity and may carry its own bytes.
`sha256` is the identity and `filename` a label; `mediaType` says whether a
consumer can show the file or only offer it; `bytes` is base64 and optional.
Six rules in *Attachments*, of which two matter most: bytes without a hash are
invalid, because bytes nobody can check are bytes nobody should trust; and a
hash with no bytes is a **known-missing** file that a consumer must report
rather than import as an absence.

**Why it took two clients to see it.** This entry was written when Talaria
wanted a canvas picture on a block. It was still a guess about the format then —
one consumer feeling one thing, which is exactly the bias this file warns about
in its own preamble. What settled it was a Supernote plugin, whose first feature
is to lasso a region and send it to Hermes as a block with an image attached: a
device whose native unit is a stroke, sharing none of Hermes' shape, needing the
same missing thing for an unrelated reason. A limit found twice from opposite
directions is a limit.

**It is additive, so `format` does not bump.** A consumer that has never heard
of `sha256` or `bytes` carries both through byte-identical under the round-trip
rule — which is why this could be a change to v0 rather than a wait for v0.1.
The first shape this entry proposed, a bytes channel beside the objects, was
dropped for exactly that reason: it lived only in the live binding and would
have left the two bindings disagreeing about what an attachment *is*.

**What it cost Hermes to say it, which is the useful part.** More than expected.
Hermes' manifest claimed `features: ["attachments"]` and its exporter emitted
`attachments.contents-do-not-travel` about the same document — a producer
arguing with itself. Underneath, it was worse than the argument suggested: the
export never touched the `attachments` table at all. `toInterchange` had no
input for it and the route never queried it, so no export had ever carried a
file *or a filename*. The claim was true only in the sense that some type
declared a field of that kind. Two words now, because they were always two
claims: `attachments` for the values, `attachment-bytes` for the files.

Three findings replace the one that went, and each names something real: a file
too large for the export's inline limit, a block whose type declares no
attachment field to hold one, and an export built without asking for files at
all. `GET /interchange?files=1` is how a caller asks — off by default, because
attachment bytes are the only part of a library whose weight is unbounded.

**What is still open**, and is the honest remainder: size. Base64 is a third
larger again, a single JSON document cannot be streamed or chunked, and a
library that is mostly large files still travels as names. The escape is
per-attachment — inline the small ones, hash the large ones — so the case is
made *legible* rather than solved, and a consumer can always tell which it got.
A binding that offers bytes a second way was the next design, and is now
closed above: *An attachment could be carried and not handed over*.

→ `fixtures/attachments.json`

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
whole feature is built on traveled as an unexplained string, and a `journal`
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
the request is what makes a repeat recognizable as a repeat. A queue that could
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
must be recognizable as a repeat. `DELETE` unmakes the membership and leaves the
object alone, and removing something that is not there is a success, because a
replaying queue cannot know which of its writes landed.

`PATCH .../collections/{c}` writes the collection's `properties`, prefixed only.
This is the one that took the most thought, because it is a bag-shaped write and
those are where implementations treat the payload as the whole object.
`set`/`unset`, a key named by neither untouched, and an unprefixed name refused —
which is the prefix rule reaching the one door it had not been applied to, on the
bag where Hermes had already been spending twenty-nine of the format's names. The
structural keys need no rule of their own: `kind`, `placement` and `members` are
not in `properties`, so nothing here can address them at all.

The shape of that bag is also the one thing this entry got wrong on the first
pass, and it is worth recording how. The fixtures were written with a
collection's own keys at the top level, the suite went green, and the mistake
only surfaced when the routes were pointed at a real library — where the keys sit
under `properties`, exactly as the document already said two sections earlier.
Sixteen green cases and fifty-six caught mutants agreeing with each other proves
they agree; it does not prove either of them read the spec.

`?q=` is a third narrowing on a read, and it inverts the rule the other two
follow. `since` and `profile` ignored give a client more than it asked for, which
is safe; `q` ignored gives a client the whole library labeled as matches, so a
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

### A membership could be written and not held — closed

Found by probing, not by reading. A canvas node was patched through the binding
to see whether a producer's own furniture survives a consumer that does not
understand it — it does, byte for byte — and the answer that came back described
a member with only the keys that had been sent. Chasing that turned up the
larger thing behind it.

`place` had honoured `version` since it was written, and the fixture proving a
stale move is refused had passed from the day it was added. Both were true and
neither did anything, because the read never issued a version. The number a
client would have to send back was one no client could obtain, so the comparison
ran every time against `undefined` and let every write through. A check that
cannot fire is worse than no check: a client that sends a version believes it is
protected.

Fixtures measure a function, and this lived in the gap between the function and
the binding. That is the second time this file has had to record it — the canvas
entry below says green cases and caught mutants agreeing with each other prove
they agree and not that either read the spec. Same lesson, found from the other
side: here they agreed with the spec and with each other, and the binding
underneath them issued nothing for them to agree about.

Closed by saying it in the format — a producer that honours `version` on a
placement MUST issue one on the read — and then by three things that had to be
true together: the read carries it, the answer carries the version the write
produced rather than the one it was given, and the comparison is part of the
UPDATE rather than a check in front of it. The last is the one that looks
optional. Read-compare-write is two statements with a gap, and two clients that
both read 7 and both find it current both write, which is the bug the version
was added to prevent, reintroduced by the shape of the check.

The membership is the right place to have found this. An object is usually
edited by whoever opened it; a placement is edited by anybody who drags anything
and by every agent asked to arrange something, so it is the most contended thing
the format has and was the least protected.

### A write costs a full export — not a format limit

Kept, moved, because it does not belong in Open and deleting it would lose the
reasoning.

`PATCH` and `PUT` both read the whole library back to find one object, because
the exporter derives relations and resolves inline mentions across the entire
set — running it on one block would resolve a mention against a library of one
and mint a stub with a fresh id. 143 objects, milliseconds, correctness over
micro-optimization, and it will not stay tolerable.

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
