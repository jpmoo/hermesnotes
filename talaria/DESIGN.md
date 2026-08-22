# Talaria — Phase 0 Design

**Status:** Phases 0, 1 and 2 done. Both core changes landed and verified; the
daemon, mirror and CLI work with the offline/reconnect scenario passing in
`acceptance/`; Talaria.app indexes into CoreSpotlight and owns the `talaria://`
scheme. Phase 3 (App Intents) not started.
**Scope:** Answers the open questions in the brief (§5), records what recon
actually found, and names the two things that block later phases.
**Companion:** `HERMES-CORE-CHANGES.md` — everything this project asks of Hermes
proper, kept separate on purpose (brief §3, §9).

---

## 0. Six findings that shape everything below

These came out of reading the current server and running the toolchain. Each one
moves a decision, so they lead rather than sit in an appendix.

### F1 — Hermes has no paginated read. Anywhere.

Every list endpoint is a bounded top-N with no offset, no cursor, and no `since`:

| Endpoint | Bound |
|---|---|
| `POST /blocks/query` | `QUERY_LIMIT = 500` (`collections/query.ts:178`) |
| `GET /blocks/of-type/:typeId` | 200 |
| `GET /blocks/search` | 25 |
| `GET /search` | 25 |

`withCount: true` on `/blocks/query` will tell you the true total, then hand you
the first 500 of it. There is no way to ask for the rest.

**Consequence:** the daemon cannot perform a complete initial pull against the
API as it stands. This is not a nice-to-have — it is the difference between a
mirror and a sample. It is the main driver of §6 below.

### F2 — The change feed the brief hoped for already exists

Migration `0027_change_log.sql` added a `changes` table fed by database triggers
on `blocks`, `memberships`, and `block_tags`:

```sql
seq bigserial PRIMARY KEY, owner_id uuid, block_id uuid, op text, version integer, at timestamptz
```

Three properties matter to us, and all three are already right:

- **One row per block per write**, including writes made during a `GET`
  (re-seeding a day, backfilling a title, mirroring a calendar feed). A
  URL-sniffing sync would miss those; a trigger doesn't.
- **`op = 'delete'` rows are recorded**, so deletions are learnable rather than
  inferable — within the retention window.
- **The `bigserial` commit-order gap is already solved.** `events/watcher.ts`
  holds a `SETTLE_MS = 200` watermark and reads only rows older than that,
  because a sequence value is handed out at write time, not commit time — so
  seq 100 can commit after seq 101 and a naive `seq > cursor` reader steps over
  it. The watcher's own comment notes this is "the same guarantee a sync cursor
  would need." It is. We inherit it.

Two limits we must design around:

- **The SSE stream at `GET /events` is deliberately cursorless.** When the last
  listener drops, the watcher sets `cursor = null` and the next connection
  resumes from the head. It is a "go and look again" nudge, not a log. Talaria
  cannot use it as its sync mechanism — only as a wake-up.
- **`KEEP_DAYS = 7`.** Rows older than a week are pruned hourly. Seven days is
  therefore the hard horizon of incremental sync.

### F3 — Block types are user data, not code

`block_types` is a per-owner table whose `property_schema` JSONB defines the
fields. The design doc's rule is explicit:

> no per-type hardcoded logic anywhere else in the codebase should special-case
> a block type. If you find yourself writing `if (blockType.name === 'task')`,
> the answer belongs here instead.

The server obeys it — recurrence is found with
`schema.fields.find(f => f.type === "recurrence")`, completion with
`isComplete(schema, props)` against `status_field` / `complete_values`.

**This collides head-on with App Intents.** `AppEntity` is a compile-time Swift
type; Hermes types are rows the user can rename, extend, or delete at runtime.
The brief's "expose the six block types as `AppEntity`" cannot be literally true
for a user who renames Task to Todo. Resolution in §1.6 and §2.

### F4 — Talaria structurally cannot destroy data

`DELETE /blocks/:id` refuses anything but a browser cookie session:

```ts
if (req.authKind !== "cookie") throw forbidden("hard delete requires a browser session");
```

The daemon will authenticate with `Authorization: Bearer` (`/auth/tokens`), so
it can archive but never hard-delete. This is a gift: the brief's "read-first"
posture is enforced by the server rather than by our good intentions. Nothing in
Talaria should try to route around it.

### F5 — Phase 3's toolchain is present (resolved 2026-08-22)

Recorded as a blocker when this document was first written; resolved the same
day. Kept rather than deleted because *why* Phase 3 needs it is still load-bearing.

App Intents requires a build-time metadata extraction pass
(`appintentsmetadataprocessor`) that produces the `Metadata.appintents` bundle
the system reads to discover intents. It is driven by the Xcode build system, not
by `swiftc`. A SwiftPM-only build does not run it, and an app bundle without that
metadata exposes no intents at all — silently, which is the worst failure mode
available. Command Line Tools alone cannot do it.

Xcode-beta 27.0 (build `27A5237l`) is now installed, and everything the phase
needs is in it:

| | |
|---|---|
| `appintentsmetadataprocessor` | present in `XcodeDefault.xctoolchain/usr/bin` |
| `appintentsnltrainingprocessor` | present — this is what builds the Siri phrase model |
| `AppIntents.framework` | present in the MacOSX 27.0 SDK |
| `CoreSpotlight.framework` | present in the MacOSX 27.0 SDK |
| Swift | 6.4, targeting `arm64-apple-macosx27.0.0` |

**One step outstanding, and it needs a password:** `xcode-select` still points at
`/Library/Developer/CommandLineTools`, so `xcodebuild` refuses to run. Until
`sudo xcode-select -s /Applications/Xcode-beta.app/Contents/Developer` is run and
the license accepted, the toolchain is installed but not active.

Note the pairing: Xcode **beta** 27.0 against macOS **beta** 27.0 (F6). That is
the correct pairing — a released Xcode would not carry the 27.0 SDK — but it
means both halves of the Phase 3 toolchain are pre-release.

### F6 — This machine is on a beta OS

```
ProductVersion: 27.0    BuildVersion: 26A5416b
```

macOS 27.0, pre-release. Everything in §7 was checked against Apple's current
documentation rather than recalled, but a beta can still move under us, and
Xcode 27 beta will be required to target it. Worth stating plainly because the
brief asks for demoable phases: "works on my beta" is a weaker claim than usual.

---

## 1. The open questions (brief §5)

### 1.1 Daemon language → **TypeScript on Node 22**

The brief offers Go and Python and weighs single-binary distribution against
iteration speed. I think the repo settles it, and neither of those is the
deciding factor.

`packages/shared` already contains the semantics of a block:

- `isComplete(schema, props)` — what "done" means, per type
- `bodyFieldKey(schema)` — where prose lives on a type
- `datedInRange(schema, props, start, end)` — what "this block is on Tuesday" means
- `recurrenceSchema` / `recurrenceContinues` — the recurrence rule
- `optionLabel`, `deriveEmbedSource`, the collection and filter grammars

A Go or Python daemon must re-implement every one of these to build a canonical
object. That is precisely the "second source of truth for what a block is" that
brief §3 forbids — and it is worse than a normal duplication, because these
functions are *schema-interpreting*: they change whenever the property-schema
grammar gains a field type. A Go reimplementation would drift silently and be
wrong only for the user's own custom types, which is exactly where nobody looks.

A TypeScript daemon adds `"@hermes/shared": "workspace:*"` and imports them.

Against this, honestly:

- **Single-binary distribution** — an explicit non-goal (brief §2). One user,
  one machine, `pnpm install` already runs here.
- **launchd and a runtime path** — real cost. A `node` interpreter path in a
  plist is more fragile than a static binary. Mitigation: pin an absolute path
  to the Node 22 binary in the plist, no `nvm` shims, and have
  `talaria doctor` assert it. If it becomes genuinely annoying, Node 22's
  single-executable-application support can produce a binary later without
  changing a line of daemon code.
- **Startup time** — irrelevant for a long-running daemon.

**Recommendation: TypeScript.** The shared-semantics argument is the only one
that touches correctness, and correctness wins over packaging on a PoC.

### 1.2 IPC → **Unix domain socket carrying HTTP/JSON**

Socket at `~/Library/Application Support/Talaria/talaria.sock`, mode 0600.

- **Debuggable by hand**, which the brief asks for directly:
  `curl --unix-socket ~/Library/Application\ Support/Talaria/talaria.sock http://x/blocks?q=foo`
- **Filesystem permissions are the authorization model.** No port, so nothing
  else on the machine — or on Tailscale — can reach it. localhost HTTP is
  reachable by every process and every browser page on the box; for something
  holding a Hermes bearer token that is a real downgrade.
- **Fastify binds a socket path directly** (`listen({ path })`), so the daemon
  reuses the stack, the error shapes, and the zod validation idiom already in
  this repo.
- **XPC is rejected** for the PoC: it wants bundle identity and entitlements on
  both ends, it is unusable from `curl`, and it drags the Swift shell's
  complexity into the daemon — the opposite of "keep Swift dumb."

Swift talks to it with `URLSession` over a `URLProtocol`-less path — practically,
a tiny `NWConnection`- or socket-backed client, ~100 lines, written once.

### 1.3 Sync strategy → **cursor on `changes.seq`, plus one new endpoint. Measure first.**

The mechanism is already built (F2); what's missing is an HTTP door onto it and
any way to read the baseline (F1).

**Proposed protocol:**

1. **Baseline.** `GET /sync/blocks?after=<uuid>&limit=1000` — keyset pagination
   by block id, returning full block rows including archived, plus the current
   `changes` head as `seq` in the envelope. Repeat until short page.
2. **Incremental.** `GET /sync/changes?since=<seq>&limit=1000` — rows from the
   change log, already settled past the `SETTLE_MS` watermark, plus
   `{ nextSeq, pruned: bool }`.
3. **`pruned: true`** when `since` is older than the oldest retained row → the
   daemon discards its cursor and re-runs the baseline.
4. **`GET /events` (existing SSE)** is used only as a nudge to run step 2 early.
   Never as the source of truth.

This is one endpoint pair and no new storage. Details in
`HERMES-CORE-CHANGES.md`.

**On full-poll for v0:** the brief says it is acceptable if the graph is small,
and to measure rather than assume. A total block count is **not obtainable over
MCP** — no tool exposes one. Every listing tool is either type-scoped
(`task_find`, `project_list`) or capped with no total (`search` reads every
block but returns 25 hits and no count). What MCP does give, measured
2026-08-22:

| | |
|---|---|
| Tasks (all statuses) | **53** |
| Active projects | **17** |
| Collections | **8** |

Not counted: text blocks, daily notes, events, persons, organizations — plausibly
the bulk of the graph. The exact total is one authenticated call away:

```bash
curl -s -H "Authorization: Bearer $HERMES_TOKEN" \
  -X POST https://<host>/blocks/query \
  -H 'content-type: application/json' \
  -d '{"withCount":true}' | jq '{total, limit}'
```

**But the number no longer decides anything, and that is the finding.** Full-poll
against `QUERY_LIMIT = 500` is not a property of the graph, it is a date. Daily
notes are one block per day, created by opening a day and never removed — roughly
365 a year, monotonically, forever. A graph at 300 blocks today crosses 500 by
daily notes alone inside two years, on its own, with no change in how the user
works.

And it crosses **silently**: `/blocks/query` keeps returning 500 rows and the
mirror simply stops learning about the rest. There is no error, no gap in the
change feed, nothing for `talaria doctor` to catch — the mirror is confidently
wrong about a growing tail of the graph. Given the brief's own rationale for
local-first (trust collapses permanently after two or three failures, and "the
thing I searched for was block 501" is unattributable), shipping on a mechanism
with a known silent expiry is the wrong trade at any current block count.

**Recommendation: build the endpoint.** Not because the graph is large — it
plainly isn't — but because full-poll's ceiling is reached by the calendar rather
than by usage, and reached without saying so.

### 1.4 Staleness → **three states, one of them loud**

The honest answer to "how stale before it lies" is that a task mirror and a
calendar mirror have different answers, but a PoC gets one policy:

| State | Condition | Behaviour |
|---|---|---|
| **Fresh** | last successful sync < 5 min, or SSE attached | Serve silently. |
| **Stale** | 5 min – 24 h | Serve, and stamp every response with `syncedAt`. CLI prints a dim `(as of 14:20)` footer. Spotlight results are unmarked — there is nowhere to put it. |
| **Cold** | > 24 h, or cursor pruned | Serve, and say so unprompted: CLI banner, `talaria doctor` non-zero. Writes are still accepted (queued), but the CLI warns before completing a task it hasn't verified in a day. |

The asymmetry that matters: **stale reads are fine, stale writes are not.** A
task list a few hours old is useful. Completing a task that was already
completed, deleted, or rescheduled elsewhere is a real conflict. So writes go
straight to Hermes when the network is up, and only queue when it is down — and
a queued write records the block `version` it was based on, so replay can detect
that the block moved underneath it and surface a conflict rather than clobber.
`version` is already on every block and already used for optimistic concurrency
by `PATCH /blocks/:id`; we get this for free by not throwing it away.

### 1.4a Writes, and what happens when two of them disagree

Talaria's entire write surface is three things: create a task, complete a task,
append to the daily note. There is no "replace this document" write, because
there is no window to type one in (brief §2). That boundary is what keeps this
tractable, and it is worth stating so it isn't crossed casually: **the moment
Talaria gains a write that replaces a document wholesale, this design stops being
sufficient** and the answer becomes real merge.

**Safety is already handled and must not be routed around.** `PATCH /blocks/:id`
is optimistic on `version` and rejects a stale write outright. Talaria inherits
that — no force flag, no refetch-and-resend loop that quietly wins races.

**What's left is usability**, and it is not a small thing. A queued write that
merely gets rejected on reconnect is safe and useless: "I marked it done on the
plane and it didn't take" is the same collapse of trust as a stale read, arriving
by a different door.

#### Queue intents, not payloads

The queue records what the user *meant*, never the document that would result.

| Not this | This |
|---|---|
| `properties = {…the whole object mirrored three hours ago…}` | `set status → done` |
| `content = "…the entire note with my line appended…"` | `append "call the roofer" to 2026-08-22` |

On reconnect each intent is re-applied against **current** state and sent with the
**current** version. Most apparent conflicts evaporate, because they were never
conflicts — two writes touching different fields of the same block.

This matters more than it looks: `PATCH /blocks/:id` takes `properties`
wholesale (`body.properties ?? current.properties`), so a replayed payload is a
whole-object replacement. Version checking keeps that *safe*; intent replay is
what makes it *succeed*.

Per intent, on replay:

- **Complete a task.** Already complete → no-op, silently (the common case when
  it was also ticked in the web app). Archived or deleted meanwhile → park and
  report; never resurrect something the user filed away. Otherwise apply against
  the fresh version.
- **Append to the daily note.** Fetch, append to the note's *current* end, send
  its *current* version. Appends are near-commutative — ordering between two of
  them yields a different document, not a wrong one. Two edges: a day **reset**
  in the meantime means the append lands on the reset note (judged correct — it
  is an append to that day, and that day still exists), and a **lost response**
  has no id to dedupe on, so replay checks whether the exact text already sits at
  the end and treats that as applied. A heuristic, and one that fails toward not
  duplicating.
- **Create.** Idempotent by client-supplied id — `HERMES-CORE-CHANGES.md` §2.

#### Conflicts are surfaced, never resolved destructively

A parked intent stays parked until the user disposes of it: `hermes queue` lists
what each one meant and why it stopped, `--retry` and `--drop` clear them, and
`talaria doctor` counts them. A queue that silently discards, or silently grows
for a fortnight, is its own failure.

#### Known drift: offline completion of completion-anchored recurrence

`spawnRecurrence` takes the completion date from the **server's** clock at write
time (`const now = new Date()`), and no client can say "this was completed at T".
Complete a `completeFrom: "completion"` task on Monday offline, replay on
Wednesday, and the next occurrence anchors to Wednesday — wrong by however long
the machine was away, silently.

Schedule-anchored recurrence is unaffected; it never consults the completion date.

**Not fixed, deliberately.** The drift is bounded by the offline interval, it
touches one of two recurrence modes, and it lands in the same territory as the
series-identity question Phase 4 forces anyway (§3.2). Recorded so it is a known
cost rather than a surprise.

### 1.5 Identity and lifecycle → **UUID is the key; archived leaves the index**

Block UUIDs are stable, server-minted, and already the deep-link key
(`/block/:id` in the web router). `CSSearchableItem.uniqueIdentifier` = the
block UUID. `domainIdentifier` = the block type id, which gives us cheap
per-type deletion via `deleteSearchableItems(withDomainIdentifiers:)`.

Verified archive behaviour: `blocks.archived_at` is a timestamp column, and the
schema comment is unambiguous —

> When set, the block is archived: hidden from every normal query and only
> visible on the Archive page.

So archive is a first-class "not part of my working set" state, not a soft
delete. **Archived blocks leave the Spotlight index.** Unarchiving re-indexes;
`POST /blocks/:id/unarchive` exists and produces a `changes` row like any other
write, so this needs no special casing — the mirror sees `archived_at` change
and the indexer reacts to the resulting state.

Note the interaction with auto-archive: `archive/worker.ts` sweeps completed
tasks after `autoarchiveDoneDays`. A user with that set will see tasks leave
Spotlight days after completion, with no explicit action. That is correct
behaviour and will still feel surprising the first time. Worth a line in the
eventual README rather than a code change.

**Deletion** has the retention subtlety. Within 7 days, an `op='delete'` row
tells us directly. Beyond that — a daemon offline for longer than the window —
the delete row is gone, and the block's absence is only visible as an absence.
This is the second reason the baseline endpoint (§1.3) must return the full id
set: reconciliation after a cold start is a set difference, and anything in the
mirror that the baseline didn't mention is deleted. Cheap, and it makes the
7-day horizon a performance boundary rather than a correctness one.

### 1.6 Canonical object shape v0 → see §2

### 1.7 Non-block things

**Daily notes — in scope, deliberately.**

They are ordinary text blocks carrying a `today_note: "YYYY-MM-DD"` property,
held out of listings by `NOT jsonb_exists(properties, 'today_note')` repeated
across the block routes, with a sentinel type id
(`DAILY_NOTE_TYPE_ID = da110000-…`) that smart collections use to opt back in.

They are held out of *listings*; they are not second-class. They have UUIDs, they
have a deep link, they are where the user actually writes, and "what did I write
on the 14th" is one of the highest-value Spotlight queries available. Indexing
them costs nothing extra — the mirror already has them — and they get a
date-titled display name so they sort and read sensibly.

The canonical layer keeps the hold-out as a flag (`isDailyNote`, `noteDate`) so
ordinary "find blocks" surfaces can exclude them the way Hermes does, and the
day-specific surfaces can ask for them.

**Canvas notes and edges — out of scope, and here is the reason.**

They live in the *collection block's* `properties` JSONB as `canvas_notes` /
`canvas_edges` arrays. They do have ids, but those ids are client-minted `uid()`
strings scoped to one collection, not UUIDs — and `canvas_edges` entries created
over MCP arrive with no id at all and get one backfilled at render time, so the
same edge can have different ids in different sessions.

The disqualifying fact is not the id format. It is that **there is no route that
opens one.** The web router has `/block/:id` and `/collections/:id`, and nothing
addressing a sticky within a canvas. A Spotlight result must be openable; an
entry that lands the user on the canvas and leaves them to find the note is a
worse result than no result, because it teaches them the index is unreliable.

If canvas notes become worth finding, the right fix is upstream — give them
stable ids and a deep link — not a Talaria workaround. Recorded here so the
decision is revisitable rather than forgotten.

### 1.7a Launchers that aren't Spotlight

Alfred, Raycast's file search, LaunchBar and anything else built on the macOS
metadata index **cannot see CoreSpotlight items**. The two are separate stores:
`mdfind` returns nothing for a block that ⌘Space finds instantly. Alfred's
Default Results pane configures exactly three things — documents, folders, text
files — and there is no plugin point.

So they are fed directly rather than through the system index. `talaria alfred`
emits Script Filter JSON and the workflow is a few lines of plist around that
one call; any launcher that can run a command and read JSON uses the same entry
point. One integration, several launchers — the same shape as the App Intents
bet in Phase 3.

Two rungs are available, and a third is not built:

1. **Keyword** (`hn something`) — works now.
2. **Fallback Search** — one row, shown when nothing on the Mac matched.
   Shipped in the workflow; the user adds it in Alfred's preferences.
3. **Blocks as files** — the only way into Alfred's *default* results, because
   that list is files. Writing each block to an indexed folder as a `.webloc`
   would put them there, ranked inline with everything else and needing no
   keyword.

   **Not built, and not obviously right.** It means several hundred files kept
   in sync as blocks come and go, every block appearing in Spotlight twice
   (once as our indexed item, once as a file), and filenames that have to
   survive titles containing slashes. It is also most of what Phase 4's File
   Provider is for, and the brief says not to start that without a conversation.

---

## 2. The seam (brief §6)

One module, `packages/canonical`. Everything downstream — CLI, Spotlight
indexer, App Intents entities — imports only from it and never sees a Hermes
payload.

The v0 shape, driven by F3: **map by role, never by name.**

```ts
export type CanonicalKind =
  | "task" | "event" | "note" | "person" | "project" | "organization" | "other";

export interface CanonicalBlock {
  id: string;                  // block UUID — the identity everywhere
  kind: CanonicalKind;         // resolved by role, not by type name
  typeId: string;              // the Hermes type this came from
  typeName: string;            // what the user calls it, for display
  title: string;
  body: string | null;         // via bodyFieldKey() — not "description"
  completion: Completion | null;
  schedule: CanonicalSpan | null;
  recurrence: CanonicalRecurrence | null;
  tags: string[];
  links: { id: string; role: string }[];
  isDailyNote: boolean;
  noteDate: string | null;
  archivedAt: string | null;
  updatedAt: string;
  version: number;             // for conflict detection on replayed writes
  url: string;                 // hermes://block/<uuid>
}
```

`kind` is inferred from the type's *shape*, in this order:

1. `builtin === true` and a recognised seeded name → that kind. Covers the
   default install.
2. Otherwise by structure: a `status_field` with `complete_values` and a
   `datespan` → `task`; a `datespan` and no status → `event`; `isText` → `note`;
   a `reference` field pointing at an org-shaped type → `person`; and so on.
3. Otherwise `other` — indexed and searchable, but not surfaced as a typed
   App Intent entity.

This is what makes a renamed Task keep working, and it is why `kind` must be a
*derived* property of the canonical object rather than a passthrough of
`type.name`. The mapper is the only place allowed to make that judgement.

**On App Intents (F3):** the entity set is fixed at the six kinds plus a generic
`HermesBlockEntity` for `other`. A user's custom type is findable and openable
but does not get bespoke Siri grammar. That is the honest trade — App Intents
cannot be dynamic — and it fails gracefully rather than invisibly.

**Enforcement, not convention.** The brief says the seam should be enforced. Two
mechanisms, both cheap: `packages/canonical` is the only workspace that depends
on the Hermes HTTP client, and an ESLint `no-restricted-imports` rule forbids
every other Talaria package from importing it. A seam that is merely documented
is a seam that leaks by week three.

---

## 3. Recurrence, and the `n` question (brief §7)

### 3.1 `n` is load-bearing. It is not vestigial and not a duplicate.

The brief flags that the stored object carries both `n: 7` and
`frequency: weekly, interval: 1`, and asks whether they encode the same thing.
They don't. Reading `packages/shared/src/recurrence.ts` and all three consumers:

- `frequency` / `interval` / `weekdays` are the **rule**: how far apart
  occurrences fall.
- `end` is the **stopping condition**: `never` / `after N` / `on <date>`.
- `n` is **instance state**: the 1-based index of *this* task within the series.

`n` cannot be derived, because each occurrence is a **separate independent
block**. Completing #3 spawns #4 carrying `n: 4`
(`blocks/routes.ts` — `spawnRecurrence`). Nothing else in the system knows how
many came before, so `end: {type: "after", count: 5}` would be unenforceable
without it. `n` and `count` meet in exactly one line:

```ts
if (rec.end.type === "after") return currentN < rec.end.count;
```

The genuine wrinkle — worth recording, not worth fixing here — is that `n` is
mutable instance state living inside an otherwise declarative rule object. Three
sites must nurse it deliberately across copies (`spawnRecurrence`,
`review/routes.ts`, `RecurrenceField.tsx`), and a fourth that forgets would
silently restart a series.

A confirmed instance of exactly that hazard was found and fixed during this
recon: `spawnRecurrence` copied the completing task's properties wholesale after
`done_at` had already been stamped, so every freshly spawned occurrence was born
`status: not done, done_at: <previous completion>`. Fixed in Hermes core, not
here. It is the same absence showing up as a bug rather than a wrinkle: with no
rule/instance boundary, every property is copied by default and correctness
depends on enumerating the exceptions by hand.

### 3.2 The absent relationship — and why it is Talaria's problem

The deeper shape: **there is no series identity.** Occurrences are linked by
nothing. `n` is a counter standing in for a foreign key that doesn't exist.

This is not an abstract complaint, because **EventKit has series identity.**
`EKRecurrenceRule` hangs off a master event with occurrences beneath it. Any
Phase 4 Reminders or Calendar bridge must present a series, which means Talaria
must synthesize a stable series identity at bridge time — Hermes will not supply
one.

The decision that follows, and it belongs in the canonical object now rather
than at Phase 4: **`CanonicalRecurrence` carries a `seriesId` even though
Hermes has no such concept.**

```ts
export interface CanonicalRecurrence {
  seriesId: string;              // synthesized; stable across occurrences
  anchor: "schedule" | "completion";
  frequency: "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
  weekdays: number[];
  end: { kind: "never" } | { kind: "after"; count: number } | { kind: "on"; date: string };
  occurrence: number | null;     // Hermes' n, surfaced honestly as instance state
  expressibleAsRRULE: boolean;   // false when anchor === "completion"
}
```

Derivation of `seriesId` for v0: the UUID of the **first** occurrence, carried
forward. This requires a Hermes change (spawn stamps the parent's series id onto
the child) and so is **deferred** — v0 derives it as
`hash(typeId, title, rule)` inside the canonical layer, which is stable for
unedited series and wrong when a title changes. That is acceptable for a
read-only PoC and unacceptable for a write bridge, which is precisely why the
field exists now: Phase 4 changes how it is *derived* without changing anything
that consumes it.

### 3.3 The RRULE trap

`completeFrom: "completion"` has no RFC 5545 expression. There is no way to say
"three days after I actually finish it."

`expressibleAsRRULE` makes the gap explicit at the seam rather than at the
bridge. The Phase 4 rule, decided now: **the rule stays authoritative in Hermes;
only materialized instances go outward.** A completion-anchored task exports as
a single Reminder with a concrete due date and no recurrence rule attached —
and when it is completed in Hermes, the next instance is pushed as a new
Reminder. Anything else is asking Apple's store to hold a rule it cannot
represent, which it will silently mangle.

---

## 4. Repo layout

```
talaria/
  DESIGN.md                  ← this file, kept current (brief §9)
  HERMES-CORE-CHANGES.md     ← everything asked of Hermes proper
  package.json               ← private workspace root for the Talaria packages
  packages/
    canonical/               ← THE SEAM. Only package that sees Hermes payloads.
      src/{map.ts,kind.ts,recurrence.ts,types.ts}
    daemon/                  ← mirror, sync loop, UDS server
      src/{server.ts,mirror/,sync/,hermes/,queue.ts}
    cli/                     ← the `hermes` command; a thin UDS client
      src/{index.ts,commands/}
  swift/
    Talaria.app/             ← thin shell: URL scheme, Spotlight, App Intents
      Sources/{Bundle,Spotlight,Intents}/
      Talaria.entitlements
      Info.plist
  launchd/
    dev.talaria.daemon.plist
  doctor/                    ← permission + wiring checks, callable from CLI
```

Added to the root `pnpm-workspace.yaml` as `talaria/packages/*` so
`@hermes/shared` resolves as a workspace dependency (§1.1). The Swift tree is
deliberately outside the pnpm graph.

---

## 5. Dependencies

**Daemon / CLI (all already in this repo's lockfile except two):**

| Package | Why |
|---|---|
| `fastify` | UDS server; same idiom as the main server |
| `zod` | request/response validation, same idiom |
| `@hermes/shared` | workspace — the whole argument of §1.1 |
| `node:sqlite` | **built in.** Unflagged on Node 22.22 (verified — an experimental warning, not a flag), so the daemon has *no* native dependency and nothing to compile. Every call to it is isolated in `mirror.ts`, so if the experimental API moves, swapping in `better-sqlite3` is one file. |
| `commander` | **new.** CLI arg parsing. Small and boring. |
| `undici` | Node 22 built-in `fetch` is fine; named only if we need connection-pool control against Tailscale flapping. |

**Swift:** no third-party packages. `AppIntents`, `CoreSpotlight`,
`UniformTypeIdentifiers`, `Network` — all system frameworks.

**Toolchain:** Xcode-beta 27.0 with the macOS 27.0 SDK, carrying
`appintentsmetadataprocessor` and both frameworks (F5). Active developer
directory still needs switching to it.

---

## 6. What this asks of Hermes core

Exactly one addition, detailed in `HERMES-CORE-CHANGES.md`:

**`GET /sync/blocks`** (keyset baseline) and **`GET /sync/changes`** (cursor over
the existing `changes` table). Both bearer-authenticated, both read-only,
neither touching existing routes. Roughly one file plus a route registration;
the hard parts — the trigger, the settle watermark, the retention policy —
already exist and are already tested in production use by the SSE watcher.

Nothing else. No schema migration. No change to any existing endpoint.

---

## 7. macOS reality check (brief §0, §8)

Checked against Apple's documentation rather than recall, on 2026-08-22:

| API | Status | Notes |
|---|---|---|
| `AppEntity` | **Current**, macOS 13.0+ | No deprecations. Requires `id` (`EntityIdentifierConvertible & Sendable`), `displayRepresentation`, and `defaultQuery`. **10 MB per-entity size cap** including child properties — irrelevant for us, but `@DeferredProperty` exists if a body field ever gets large. |
| `EntityQuery` family | **Current** | `EnumerableEntityQuery`, `EntityStringQuery`, `EntityPropertyQuery` are the specialisations. `EntityStringQuery` is the one Spotlight-driven lookup wants. |
| `CSSearchableItem` | **Current**, macOS 10.11+ | No deprecations. `init(uniqueIdentifier:domainIdentifier:attributeSet:)` unchanged. `expirationDate` and `isUpdate` both still present and both useful to us. |
| `EKEventStore.requestFullAccessToEvents` | **Current**, macOS 14.0+ | Requires `NSCalendarsFullAccessUsageDescription`. Replaces the old `requestAccess(to:)`. Phase 4 only. |
| SiriKit `INIntent` | **Superseded** | The brief's warning is correct: a large corpus of deprecated `INIntent`/`INExtension` code reads as current. Nothing in Talaria should touch it. |

**Two things that will bite, both confirmed:**

1. **CoreSpotlight requires resolvable bundle identity.** Indexing from a plain
   executable fails with `-1003` and `corespotlightd` logging "Could not resolve
   bundle id" — and it fails *at index time*, not at call time, so the code
   looks like it worked. This is the structural reason the Swift shell must be a
   real `.app` even though it has no windows, and it confirms the brief's
   architecture. It also means the **daemon must not index**; it hands items to
   the app over the UDS socket and the app calls `CSSearchableIndex`.

2. **App Intents metadata is an Xcode build-system product** (F5). Absent it,
   intents are not discovered and the failure is silence. The tooling is now
   present; `talaria doctor` should still assert that the built bundle actually
   contains `Metadata.appintents`, because a misconfigured build fails quietly
   rather than loudly.

**`talaria doctor` should exist from Phase 1, not Phase 4.** Everything above
fails silently. Checks: Node path resolves, socket present and 0600, bearer
token valid, last sync age, bundle registered with LaunchServices, `hermes://`
scheme claimed, Spotlight index item count, and — from Phase 4 — TCC grants for
Calendar/Reminders/Contacts.

---

## 8. Deviations from the brief

1. **The change feed is not new work.** Brief §5.3 asks what the cheapest change
   feed to add would be; the answer is that it exists and needs only an HTTP
   door. The real gap is the *baseline* read (F1), which the brief did not
   anticipate.
2. **"Six block types as AppEntity" is qualified**, not adopted literally (F3).
   Six kinds resolved by role, plus a generic entity for user-defined types.
3. **Daily notes are in scope** where §5.7 offered "no, and here's why" as an
   acceptable answer. They are the highest-value thing in the index.
4. **The CLI is `talaria`, not `hermes`** (brief §4). `hermes` is already a
   command on this machine — Hermes Agent, by Nous Research, entirely unrelated
   — and shadowing a tool the user installed is not something to do quietly. The
   brief also called the health check `talaria doctor`, so one name for one
   binary is what it wanted anyway.
5. **`seriesId` enters the canonical object at v0** despite Hermes having no such
   concept (§3.2). This is the one place I am adding a field to a
   near-identity-function mapper, and §3.2 argues why the alternative is a
   Phase 4 rewrite.

## 9. Before Phase 1 starts, I need

1. ~~**The block count**~~ — measured as far as MCP allows (§1.3): 53 tasks, 17
   projects, 8 collections, with text blocks and daily notes uncounted. It no
   longer decides anything: daily notes push the graph past the 500 ceiling on a
   timetable regardless of the current total, and silently. The recommendation is
   the endpoint either way.
2. ~~**A decision on Xcode**~~ — resolved (F5). Xcode-beta 27.0 is installed
   and complete; only `sudo xcode-select -s` remains, and that is a password
   step rather than a decision.
3. **Sign-off on the core endpoint** (§6) — it is the only thing here that
   touches Hermes proper.
