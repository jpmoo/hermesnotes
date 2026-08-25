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

### External feeds are outside the model

**Needed for:** calendar events Talaria shows from subscribed ICS feeds.

**What the format has:** nothing. These are not objects in the library — they
come from a third party, they are read-only, and they vanish when the
subscription does.

**Probably correct as-is.** Noted because a consumer that renders a calendar has
to get them from somewhere, and today that is a Hermes route.

---

## Closed

*(entries move here when a spec change lands, with the version that fixed them)*
