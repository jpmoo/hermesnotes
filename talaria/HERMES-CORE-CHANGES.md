# Changes asked of Hermes core

Kept separate from Talaria's own code on purpose (brief §3, §9). Nothing here is
written yet — this is the proposal that `DESIGN.md` §6 refers to.

**Status:** §1 and §2 implemented and verified 2026-08-22. §3 still deferred.

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

## 3. Deferred: series identity on recurrence

**Not proposed for now.** Recorded because `DESIGN.md` §3.2 depends on it and
the deferral should be a decision rather than an omission.

Recurring occurrences are separate blocks linked by nothing; `n` is a counter
standing in for an absent relationship. EventKit models recurrence as a master
with occurrences beneath it, so a Phase 4 Calendar/Reminders bridge needs a
stable series identity that Hermes does not have.

The eventual core change is small: when `spawnRecurrence` creates the next
occurrence, stamp the parent's series id (the first occurrence's UUID) onto the
child. Until then, Talaria synthesizes `seriesId` inside the canonical layer —
stable for unedited series, wrong when a title changes, and acceptable only
because the PoC is read-only.

Revisit before any write bridge to an Apple store.

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
