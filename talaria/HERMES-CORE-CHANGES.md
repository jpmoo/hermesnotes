# Changes asked of Hermes core

Kept separate from Talaria's own code on purpose (brief §3, §9). Nothing here is
written yet — this is the proposal that `DESIGN.md` §6 refers to.

**Status:** §1 and §2 implemented and verified 2026-08-22. §3 landed 2026-08-23.

---

## 1. A sync surface — `GET /sync/blocks`, `GET /sync/changes` ✅ landed

### Why

Two gaps, one of which is not obvious from outside:

- **No paginated read exists.** Every list endpoint is a bounded top-N with no
  offset and no cursor (`QUERY_LIMIT = 500`, `/blocks/of-type` 200, search 25).
  A mirror cannot be complete without one, and — worse — it becomes incomplete
  *silently* as the graph grows past the limit.
- **The change log has no HTTP door.** `changes` (migration 0027) records
  everything we need, but the only consumer is the in-process watcher feeding
  SSE, and that stream is deliberately cursorless: it resumes from the head when
  the last listener drops, so it can nudge a client to re-read but cannot tell
  one what it missed.

### What

Two read-only, bearer-authenticated routes. New file, new prefix, no existing
route touched.

```
GET /sync/blocks?after=<uuid>&limit=1000
  → { blocks: [...blockView, archivedAt, ownerScoped], seq: <changes head>, next: <uuid|null> }
```

Keyset pagination ordered by `blocks.id`. Includes archived blocks (the mirror
needs `archived_at` to decide indexing — `DESIGN.md` §1.5) and excludes nothing
else, including daily notes, which ordinary listings hold out. `seq` is the
change-log head captured at the start of the walk, so a client that finishes the
baseline can begin incremental reads from a point it knows it has covered.

```
GET /sync/changes?since=<seq>&limit=1000
  → { changes: [{ seq, blockId, op, version, at }], nextSeq: <seq>, pruned: <bool> }
```

Rows above `since`, **filtered to those older than the existing 200 ms settle
watermark** — the same guard `events/watcher.ts` already applies, and for the
same reason: a `bigserial` is assigned at write time, not commit time, so seq
100 can commit after seq 101 and a naive `seq > cursor` reader steps over it.
This is not a new invariant; it is the existing one, exposed.

`pruned: true` when `since` predates the oldest retained row (retention is
`KEEP_DAYS = 7`), telling the client to discard its cursor and re-run the
baseline.

### Verified

Exercised end-to-end against a throwaway Postgres carrying the real
`0027_change_log.sql` trigger, then torn down. What the run established:

| | |
|---|---|
| Owner scoping | another user's blocks and change rows absent from both routes |
| Archived blocks | present in the walk, flagged, not hidden |
| Tags | returned as a real array, sorted (`["alpha","zeta"]`) |
| Keyset paging | one row at a time walks the account and terminates on `next: null` |
| `op` on a delete | `"delete"` with a null version |
| Settle window | a write read immediately returns 0 rows; the same read 400 ms later returns 1 |
| `pruned` | false when the cursor reaches the oldest retained row; true when the log has been emptied behind a cursor that is behind the head |
| Bad key | 401 |

One bug was caught this way and would not have been caught otherwise: drizzle
renders an interpolated column reference inside a raw SQL fragment as a bare
name, so `${blocks.id}` in the tag subquery became `"id"` — which binds to
`tags t`, a table that also has an `id`. It would have correlated against the
wrong table and returned no tags for anything, silently, with no error. The
subquery now names `blocks.id` explicitly.

### Size

Roughly one route file plus a registration line. No migration. No schema change.
No new background work. The hard parts — the trigger, the settle discipline, the
retention sweep — already exist and already run in production.

### What it deliberately does not do

- **No write path.** Talaria writes through the existing `PATCH /blocks/:id`,
  `POST /blocks`, and the today routes, with their existing `version` optimistic
  concurrency.
- **No new auth.** Bearer tokens from `/auth/tokens`, and hard delete stays
  cookie-only — a bearer client can archive but never destroy
  (`blocks/routes.ts`). Talaria inherits that limit rather than routing around
  it.
- **No payload changes** to any existing endpoint.

---

## 2. A client may name a new block's id ✅ landed

### Why

`POST /blocks` minted the id server-side, which is fine for a browser and not
fine for anything that writes over a network it doesn't control. If the response
is lost in flight, the client holds no fact that separates *it never landed* from
*it landed and I didn't hear*. Retrying makes two blocks; not retrying loses one.
There is no local information that resolves it.

That put it straight against Phase 1's acceptance criterion — "reconnecting
reconciles without duplicates" — for the single highest-value write in the whole
project: adding a task while offline.

### What

`POST /blocks` takes an optional `id`. The insert is `onConflictDoNothing`; when
nothing comes back, the block is returned if it belongs to the caller (the create
they asked for has already happened) and refused as a taken id if it doesn't —
without saying whose it is or what it holds.

Conflict handling sits in the insert rather than in a check before it, so two
copies of the same create arriving together resolve correctly instead of racing.

A replay **never overwrites**: a create is a create, not an upsert. Sending the
same id with different content returns what is already stored.

### Verified

Against a throwaway Postgres:

| | |
|---|---|
| create with a client id | 201 |
| exact replay | 200, same block |
| replay with different content | 200, **original content unchanged** |
| another user claiming that id | 409, nothing disclosed |
| no id supplied (every existing caller) | 201, twice running, no false conflict |

---

## 3. Series identity on recurrence ✅ landed

### Why

Recurring occurrences were separate blocks linked by nothing, and `n` was a
counter standing in for an absent relationship. EventKit models recurrence as a
master with occurrences beneath it, so a Phase 4 Calendar/Reminders bridge needs
a stable series identity. Talaria synthesized one from the type, the title and
the rule — stable for a series nobody edits, wrong the moment a title changes,
and acceptable only because the PoC is read-only.

### What

A `series` table holding one rule, with `blocks.series_id` pointing at it.
`ON DELETE SET NULL`, never cascade: removing the rule that governs a repeating
task must not remove the work. Created when a block gains a rule, kept in step on
every write, and inherited by each new occurrence on completion. `n` is no longer
written — the series is counted.

`series_id` travels in the sync payload as of **payload version 3**, so mirrors
re-walk once and stop guessing. The synthesis in `canonical/recurrence.ts` is now
the fallback for blocks written before Hermes had series, and can be deleted once
none remain.

### Verified

Migration applied on a throwaway cluster; `pnpm series:backfill` dry-run,
grouped, applied, and run twice; `n` stripped from the stored rule; deleting a
series left the blocks standing. Twelve series on the live account, and the
interchange export emits them as real recurrences — `unsupported` is empty.

### What it deliberately does not do

Reconstruct history. Occurrences that predate the table are not joined into their
old series, because nothing ever recorded which belonged together and guessing
would be inventing. Each existing task became a series of one and grows forward
from where it stands.

---

## 4. Already landed during Phase 0 recon

**`done_at` leaked across recurrence occurrences.** `spawnRecurrence` copied the
completing task's properties wholesale after `stampDoneAt` had already written
`done_at`, so each freshly spawned occurrence was born `status: not done` while
carrying the previous occurrence's completion timestamp. Auto-archive was spared
only by its second filter (it re-checks `isComplete` in JS after the SQL
`done_at` cutoff), and the stale value cleared itself on the block's first
ordinary edit — but until then it was simply wrong, and it would have reached
Talaria's canonical object as a completion date on an incomplete task.

Fixed in Hermes core, commit `0f3e7d2`. Called out here per brief §9 because it
is a core change made in service of this project.

---

## 5. The writes a collection owns ✅ landed

### Why

Talaria grew a canvas surface, and a canvas is the one thing in Hermes that the
binding could read and not touch. Node geometry arrives as a member's `context`,
sticky notes and edges as `hermes:`-prefixed keys on the collection, and the
seam already strips the prefix — reading worked on the first try. Writing had
nothing at all: no coordinate write, no way to add or remove a member, no write
for a collection's own keys, and no search, so *find a block and put it on the
canvas* had no way to do either half.

The alternative was Hermes' private `/collections` routes, which is the coupling
the port existed to remove. So the format grew instead.

### What

Four routes on the binding, and two shapes on Hermes' own routes underneath
them.

- `PATCH /interchange/collections/{c}/members/{o}` now takes `context` and
  `unset` as well as `region`, and refuses whichever one the collection's
  `placement.semantic` says is wrong.
- `PUT` and `DELETE` at the same address make and unmake a membership. `PUT`
  creates and never edits; `DELETE` unmakes the membership and leaves the object
  alone, and removing one already gone is a success.
- `PATCH /interchange/collections/{c}` writes the collection's own keys,
  prefixed only. The prefix comes off on the way to storage — Hermes keeps its
  own keys unprefixed in its own database, and the prefix is the format's way of
  saying whose they are on the wire.
- `GET /interchange?q=` narrows a read to what matched, most relevant first, no
  scores. It delegates to Hermes' own `/search`, so the ranking is not a second
  copy. Unlike the other narrowings it is not permission to send less: a
  producer that cannot search must refuse rather than answer unfiltered.

In Hermes core: `PATCH /collections/:id/members/:blockId` gained `unsetContext`,
because `context` merges and a merge can never express a removal; and
`PATCH /collections/:id` gained the `{ patch: { set, unset }, version }` shape
that `PATCH /blocks/:id` already had, rather than a third spelling. The
collection write could not simply go through `/blocks/:id` — that path computes
a block's embed source, and a collection's is its title and description, so it
would have quietly rewritten the text every collection is searched by.

### Verified

Sixteen new fixture cases in `fixtures/membership.json`, nine new mutants, all
caught: 142/142 and 56/56. Hermes measured against the suite still earns
produce 4, consume 4, operate 4, and `CONFORMANCE` is not raised by hand.

### What it deliberately does not do

Give sticky notes ids. They can be written now and still cannot be addressed, so
nothing outside Hermes can link to one and the connections between them cannot
be stated as relations. That limit is in `AGENTS.md` and stays there: ids would
fix it and would also make every canvas doodle a first-class object in
everyone's library.
