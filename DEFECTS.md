# Open defects and doc drift

Found by reading the tree rather than by anything failing, which is the point:
each of these is a thing that looks healthy and is not. Each entry says what
breaks and how to prove it, so the fix can be checked rather than believed.

**Status, on re-inspection.** Items 1 through 4 are fixed in the code, and 5 is
partly done. They are kept rather than deleted because the reasoning is the
valuable part and because a fixed defect with no record is one that comes back.
What is *not* acceptable is this file quietly listing repairs as outstanding —
which it did, which is the same doc drift item 5 is about.

**Still open:** the fixture for #2, and most of #5.

---

## 1. The envelope contradicts the manifest — **fixed**

**Where:** `packages/interchange/src/map.ts`, the `conformance` block inside the
returned envelope.

**What:** `toInterchange` hardcodes

```json
{ "produce": 2, "consume": 0, "operate": 0, "bindings": ["file"] }
```

into every envelope it builds, and `apps/server/src/interchange/routes.ts` serves
that envelope from `GET /api/interchange`. Meanwhile `src/conformance.ts` — the
constant `GET /api/conformance` serves, and the one `pnpm measure` checks — says
`produce: 4, consume: 4, operate: 4` over `["file", "http", "mcp"]`.

**Why it matters:** a consumer that reads the envelope, which is the more natural
thing to do because it arrives unasked, concludes Hermes is a file-only level-2
producer that cannot read and cannot be written to. This is the failure the route
file's own header comment describes ("A promise the data does not back is the
exact failure the manifest rule exists to catch, and it caught its own author"),
arriving a second time through the opposite door — and this time the checked
manifest is the *optimistic* one, so nothing catches it.

Talaria's `discrepancies()` will not catch it either: it holds `said` from
`/conformance` against the envelope's *behaviour*, and never looks at the
envelope's own inline manifest.

**The fix is not simply to copy `CONFORMANCE` in.** A file export genuinely
cannot demonstrate consuming or operating, so what the envelope should carry is a
real question the spec does not currently answer. Whatever is decided, the two
must stop disagreeing silently.

---

## 2. A region with a label does not survive import — **fixed, no fixture**

**Where:** `packages/interchange/src/import.ts`, the collection loop.

```ts
const placement = (c.placement ?? {}) as { semantic?: boolean; regions?: string[] };
const names = placement.regions ?? [];
matrix_regions: names.map((n) => ({ title: n, tag: n }))
const region = typeof m.region === "string" ? names.indexOf(m.region) : -1;
```

**What:** `regionsOf` in `map.ts` is careful to emit `{ name, label, "hermes:…" }`
whenever the slug and the label differ, because a board whose regions a consumer
can match on and cannot render draws "Region 3" over somebody's own words. The
importer casts that list to `string[]` and indexes straight into it.

**What breaks, against a labelled region:**

- `names.indexOf("delegate-wait")` returns `-1`, so **every member on that board
  loses its placement**;
- the finding fires as `placement.region-not-declared` with `owner: "format"`,
  blaming the specification for the importer's cast;
- `matrix_regions` is rebuilt with a region *object* where a title string
  belongs;
- the region's `hermes:`-prefixed extras are dropped, which is the round-trip
  rule broken by the code that publishes the region.

**This is a known bug in its second home.** Talaria found and fixed exactly this
on its own side; the comment on `regionNameAt` in
`talaria/packages/daemon/src/interchange.ts` describes it: *"both of which cast
the region list to `string[]` and indexed straight into it. That was true until a
region grew a label."* The cast was what silenced the compiler there too.

**Why nothing caught it:** `pnpm foreign` round-trips `example/library.json`,
which has no labelled regions. Same shape as `placement/position-is-opaque`
passing under a locale-aware sort because its data was `a0 / a0V / a1` — a
fixture that does not contain the discriminating case.

**To prove it:** add a case to `fixtures/placement.json` whose collection
declares `{ "name": "delegate-wait", "label": "Delegate & Wait",
"hermes:color": "#5fa4b5" }` with a member sitting in it, and round-trip it.
Fix the type, share one `regionName()` helper between map and import, and keep
the fixture.

---

## 3. Two comments in `map.ts` now assert things that are false — **fixed**

The block above `unsupported` still reads:

> Recurrence is the honest one: Hermes plainly has it and cannot say so here,
> because the format wants a series and Hermes has no series.

Migration `0030_series.sql` landed the series table,
`HERMES-CORE-CHANGES.md` §3 records it verified, `outSeries` emits real series
objects, and `features` includes `"series"`. A comment explaining an absence that
has since been filled is worse than no comment, because the next reader will
trust it.

Check the neighbouring comments in the same function while fixing this one.

---

## 4. Cursor and prune horizon are computed across all owners — **fixed**

**Where:** `apps/server/src/interchange/routes.ts`, the `/interchange` handler.

`head.seq` and `head.oldest` are selected from `changes` with **no** `ownerId`
filter, while the delta rows below are `eq(changes.ownerId, userId)`.

The cursor being global is fine — it is opaque and monotonic, and another user's
write merely advances yours harmlessly. `oldest` is the one to look at twice: it
decides whether to answer `410 Gone`, and a global minimum can only be older than
this owner's own oldest retained row, so the check under-fires. Time-based
retention (`KEEP_DAYS = 7`) moves them together in practice, which is why this
has not bitten — but the reasoning that makes it safe is not written down
anywhere, and a follower quietly missing objects is the worst of the three
outcomes and the one that looks like success.

Either scope both to the owner or write down why global is correct.

---

## 5. Documentation drift

In descending order of consequence.

**`mirror.ts`'s header** described blocks as "the JSON that `/sync/blocks`
returned". `sync.ts` says that stopped being true — it used to call
`/sync/blocks`, `/sync/changes` and `/block-types`, and now calls
`GET /interchange`. Same family as the stale `map.ts` comments above: a comment
describing a route the code no longer calls. **Fixed.**

**`talaria/DESIGN.md` §3.2** still argues `seriesId` should be synthesized as
`hash(typeId, title, rule)` and calls the real series table deferred.
`HERMES-CORE-CHANGES.md` §3 says it landed 2026-08-23 and demoted synthesis to a
fallback for blocks written before Hermes had series. The header of DESIGN.md was
updated; §3.2 was not.

**`talaria/DESIGN.md` §1.4a** says `hermes queue`. §8.4 is the deviation
establishing that the command is `talaria`, because `hermes` already belongs to
Hermes Agent on this machine.

**`pkm-interchange/check/README.md`** says "export the eight operations".
`fixtures/README.md` and `AGENTS.md` both say ten.

**Case counts disagree across documents** — the root `README.md` says 69,
`packages/interchange/README.md` says 66 and 64 in different paragraphs. Probably
fixture growth, but they read as claims.

**`LIMITS.md` is unreachable.** The root README points at `AGENTS.md` for known
limits, and `AGENTS.md`'s *Known limits of v0* holds two. `LIMITS.md` holds seven
open ones from the only real port anyone has attempted, and nothing links to it.
It is the most useful document in the set for deciding what v0.1 owes people.

**`talaria/DESIGN.md` F5** still lists `sudo xcode-select -s` as outstanding.

---

## 6. A collection's top-level keys had nowhere to land — **fixed**

Found by adding `url` to the format rather than by reading the code, which is
why it is worth writing down.

**Where:** `packages/interchange/src/import.ts`, the collection loop.

Objects have carried their unrecognised keys into `pkm:carried` since level 2
was claimed. Collections never did — and nothing was visibly wrong, because
every key the format had for a collection was consumed by the handler just
above it. There was genuinely nothing left over to lose.

Then the format grew `url`, and a collection's address vanished on import with
no finding and no trace. The round-trip rule broken not by mishandling a key but
by there being **no place a new one could land**.

**The shape worth remembering:** an exhaustive handler is only exhaustive until
the format grows, and it fails silently at exactly the moment it stops being so.
An object's loop was written as "everything I do not recognise"; a collection's
was written as "these six keys". The first survives a new field and the second
cannot.

**To prove it:** round-trip a collection carrying a top-level key nothing reads.
It should come back byte-identical.

---

## 7. Still to do

- **A fixture for #2.** A collection declaring
  `{ "name": "delegate-wait", "label": "Delegate & Wait", "hermes:color": "#5fa4b5" }`
  with a member sitting in it. The fix is in; nothing stops it regressing.
- **A fixture for `url`.** A producer emitting one, a consumer round-tripping it
  unchanged, and a consumer refusing to synthesise one for an object that
  arrived without it.
- **`README.md` does not mention `url`.** The level-0 walkthrough is where a new
  producer would learn to emit an address, and it is the one document written for
  somebody who has not read the spec.
- **The remaining drift in #5.**

---

## 8. Housekeeping, not a defect but time-sensitive

`.claude/settings.local.json` contains a Hermes bearer token in plain text
(several times, inside the permitted-command strings) and a personal calendar
feed URL. `.claude/` is not in `.gitignore`, and this repository is public.

Check whether the file is tracked. If it is, the key needs revoking in
Settings → Access Keys, not just removing from the working tree — history keeps
it. Add `.claude/settings.local.json` to `.gitignore` either way; the
`.local.json` suffix is the convention for a file that is not meant to be shared.

There is also a `.claude/settings.local 2.json`, which is a sync conflict copy
and carries the same contents.
