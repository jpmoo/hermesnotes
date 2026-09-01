# Ambient — the desktop as a PKM surface

**Status:** design brief. Nothing here is built.
**Scope:** what Talaria becomes when BetterTouchTool, a tiling window manager and a local inference
box join it. Written in the same spirit as `DESIGN.md`: decisions with the
reasoning attached, open questions named rather than resolved early.

---

## The thesis

`packages/canonical` exists because a seam that is merely documented leaks by
week three. The same rule has to hold one level further out:

> **BetterTouchTool and the window manager are sensors and surfaces. They are never clients of
> Hermes.** Everything reaches the library through the Talaria socket, and
> Talaria speaks nothing but `pkm-interchange` to the server.

The failure mode is specific and it is what every "I wired my Mac to my notes"
setup becomes: a BTT script that curls a Hermes route, a window-manager handler that curls
a different one, an Alfred workflow with its own copy of the token. Three sources
of truth for what a block is, three things that break when the schema moves, and
the bearer key in four config files.

**Only the daemon holds the token. Only the daemon knows Hermes exists.**
Everything else calls `talaria`. Hold that and four apps compose into one system;
break it and they are a pile of shortcuts with a shared hotkey namespace.

This is the same argument `DESIGN.md` §1.1 makes about re-implementing
`isComplete` in Go, pointed at the desktop instead of at a language.

---

## Roles

| | role | what it contributes |
|---|---|---|
| **AeroSpace** | **the context sensor**, and arrangement | `aerospace list-windows --focused --format '%{app-bundle-id}\t%{workspace}\t%{window-title}'` reads all three facts in one call; `aerospace workspace N` arranges; `on-focus-changed` and `exec-on-workspace-change` in its config run a command on change |
| **BetterTouchTool** | **surface**, and the apps the window manager does not manage | floating menus host a webview; hotkeys; conditional activation groups for anything outside a managed window |
| **Alfred** | one more search entrance | already fed by `talaria alfred`; nothing new required |
| **Talaria** | **the bus** | socket, mirror, FTS, queue, URL scheme, `doctor` — all of it already exists |
| **Local inference box** | the thing that runs when nobody is asking | lives on the LAN where Hermes lives, not on the Mac |

**The window manager is the sensor, not BTT.** An earlier draft of this document
had it the other way round, on the assumption that window titles were BTT's to
observe. They are not — a window manager already tracks them, and can run a
command when they change. The sensor wiring is a line of its config, and there
is no glue at all. The thesis above — *sensors call `talaria`* — turns out to be
a shape window managers already ship.

BTT keeps the surface work, which is what it is actually best at, plus context
for windows the window manager is not managing.

**Written against Rift, now running on AeroSpace,** and worth recording what
survived the swap. Everything above did: the roles, the argument for which tool
is the sensor, the shape of the wiring. What changed was one function in the
daemon — `frontmostFromAerospace`, thirty lines — because the design never
depended on a particular window manager, only on there being one that could be
asked.

Two things got better. AeroSpace answers application, workspace and title in a
single formatted call rather than a whole workspace tree to walk. And it returns
a real window title where Rift returned an empty string for Chrome and several
others — the defect that sent title-reading into an accessibility call inside
the app, where it has stayed because it is better there anyway.

**The poll stays, and the reason is better than "not done yet."**

`exec-on-workspace-change` is declared in AeroSpace's own config and run by its
daemon, so unlike Rift's subscription it does not die with the terminal that
started it — which was the original reason for polling. That looked like an easy
win until the callbacks were actually enumerated:

    on-focus-changed · on-focused-monitor-changed · on-window-detected
    on-mode-changed · on-flatten-containers · on-padding
    exec-on-workspace-change

**There is no title-change callback.** Rift had `window_title_changed`;
AeroSpace has nothing for it. So a push would miss the case where the title
changes while focus and workspace do not — a browser tab, a different document
in the same editor — which is the richest signal the record holds, and precisely
for the applications on `TITLE_TRUSTED` that are allowed to contribute one.

A hybrid would work: callbacks for immediate workspace and focus response, a
slower poll for titles. But then the poll still runs, and what is bought is "up
to two seconds faster on a workspace switch, and fewer wakeups" — against
installing a callback into a config file this project does not own, which has to
be kept in step with it. The poll is also cheaper than it looks: `noteContext`
writes only on change, so two-second polling produced 483 rows across eight
hours rather than fourteen thousand.

Worth revisiting if AeroSpace grows a title event. On Hyprland it would already
be worth doing — `.socket2.sock` emits `windowtitlev2`, which is the missing
piece.

On the last row of that table: the box is a headless network appliance. Which
preserves the property Talaria already has and must keep — **reads never touch
the network, and the AI is the one thing that does.** That is already true of Ask
Hermes today, so nothing changes structurally.

### Three things established by installing it

**Keybindings and CLI commands are one vocabulary.** Rift's config parser
expands keybindings into `(Hotkey, WmCommand)` tuples, and `WmCommand` is the
same enum `rift-cli execute` drives. Everything bindable is scriptable and the
reverse. So **Talaria never needs to own a hotkey for a window-management
action** — it drives Rift by CLI, and hotkeys stay wherever they are most
convenient to edit. BTT can own the entire hotkey namespace and dispatch to Rift,
which is also the fix for the contention this stack will otherwise have: two
processes registering global bindings independently and racing.

**Rift's config is writable at runtime, over IPC, by dot path.** `ConfigCommand`
takes paths like `settings.animate`. Talaria can reconfigure Rift live — no fork,
no file rewriting, and Rift never learns why.

**Every failure in the stack is silent.** Getting Rift running took four
iterations, and all four looked like success from outside: the service stopped
itself after the accessibility prompt; a single unknown config key killed the
daemon on parse (`deny_unknown_fields`, strict on purpose) and launchd let it
stay down; the config file sat unread in the wrong directory while its settings
appeared to have been applied; and a status item can be hidden behind a notch in
space that looks empty.

None of that is a complaint about Rift — it is the ordinary condition of a
desktop assembled from four independent programs, and it is the strongest
argument in this document for the next section.

### `talaria doctor` has to cover the whole stack

It already exists and already has the right philosophy: *everything that fails
quietly, asked out loud.* The ambient stack multiplies what can fail quietly, so
the checks grow with it — is Rift's Mach service registered; is its config file
where Rift reads it and does it parse; is the event subscription actually
registered; does anything else hold a binding Rift or BTT expects; is the context
stream arriving. A stack of four programs with no single place to ask "is this
whole thing healthy" is one that degrades without announcing it, which is the
failure this project spends most of its rules preventing at the data layer and
would be silly to accept at the desktop layer.

Build this alongside, not after.

---

## Five capabilities

### 1. Reference, not just capture

Everyone builds capture; Talaria already has it twice over. Almost nobody builds
the reciprocal: putting a link *to* a block into whatever application you are
currently in, in the format that application wants. Hotkey, fuzzy picker over the
mirror, paste — a Markdown link in a code editor, a rich link in Mail, a bare
`talaria://` where the field linkifies.

BTT knows the frontmost app. Talaria knows the blocks. Neither knows both, which
is the whole reason this does not exist yet.

Smallest thing here, needs no new infrastructure, and it is the one that makes
the library feel like it is *inside* every app rather than beside them.

### 2. Context as a rolling record

Frontmost app, window title, workspace, selection, current calendar event, active
tab URL. All of it currently observed by the machine and discarded. Collected, it
does three jobs: scopes search, defaults capture, grounds the AI.

**Design constraint, set now:** context is a *query key, never a stored truth*.
Derived, decaying, not a block.

**Open, and worth not answering early.** A bounded stretch of work — one
workspace, one project, ninety minutes — arguably *is* a block, and the daily
note is the closest existing thing to it. Deciding that too early is how this
becomes an activity log nobody reads.

### 3. The ambient panel

Not a search box you invoke — a surface that is always showing what the library
knows about what you are looking at, redrawn on the context signal rather than on
a timer. Backlinks to the current document. Tasks naming this project. The daily
note line you wrote about this three weeks ago.

This is where the system stops being a set of shortcuts and becomes a property of
the machine.

### 4. Workspace bound to project

Switch to workspace 3 and everything scopes to one project: the panel, the
picker's ranking, capture's default parent. Rift workspaces stop being window
buckets and become library contexts.

The inverse is the better half: opening a project in Hermes asks Rift to arrange
its workspace. A project page that owns windows.

**The binding key is the workspace name.** Rift's `workspace_changed` event
carries `RIFT_WORKSPACE_NAME`, `rift-cli query workspaces` returns the set, and
per-workspace layouts and layout persistence already exist. A workspace named
after a project *is* the binding — no new mechanism, and nothing has to be
stored in two places.

Note what the name is to Rift: an opaque string it never interprets. That is the
same discipline the format applies to `position` and to `id`, and it is what
keeps this from being a violation of the thesis. Even if a workspace name were
one day a block id, **Rift would still not know what a block is.**

### 5. Background inference, not on-demand

A box with idle capacity changes what the AI is *for*. Not "ask a question, get
an answer" — continuous, low-stakes proposal generation. Which daily-note lines
want to be tasks. Which stubs are duplicates. Which tasks have quietly gone
stale. Which blocks belong to a project nobody filed them under.

Delivered as a review queue and **never written**. Hermes already has the right
home for it in the weekly-review flow, and the right posture: a bearer client can
archive but can never hard-delete (`DESIGN.md` F4).

Needs a budget and a decay. An unbounded proposal generator produces noise, and a
review queue people stop opening is worse than no queue.

---

## What this owes the format, and what the format owes it
An agent that speaks only `pkm-interchange` will hit these in this order. They
are `LIMITS.md`, arrived at independently from the other end — which is the
useful part: **this project is the second implementation the spec's contributing
section asks for, and building it is how v0.1 gets designed rather than
guessed.**

| | limit | blocks |
|---|---|---|
| 1 | ~~**There is no create**~~ — **closed**, `PUT` at a client-chosen id | proposing anything at all |
| 2 | **There is no tag write** | filing what was proposed |
| 3 | ~~**An object has no address**~~ — **closed**, see below | every surface that links |
| 4 | `derivations` names the feature, not the query | re-evaluating a smart collection |
| 5 | No sort or grouping on a collection | rendering a board as arranged |

The first three were small, and two are done. `PUT` an object at a client-chosen
id — specified, fixtured and shipped, and it makes creation idempotent by
construction exactly as predicted here; `url` on an object; and still open,
`addTags`/`removeTags` on the patch.

Worth recording that this table predicted the design before the spec had it.
The entry read "`PUT` an object at the id the client picked" months before
`fixtures/create.json` existed, and that is what the second implementation is
for — the shape was obvious from the outside and invisible from within a single
producer.

### #3 is closed, and the picker is why

Clicking a search result made "an object has no address" *worth specifying*. The
picker made it blocking, and the difference is worth keeping hold of because it
is a test for whether a limit is real: every other feature here degrades
gracefully without an address — you can rank, scope, default and summarize with
none. A picker that drops a link into whatever you are writing in has **nothing
left**, because the address is the entire deliverable. It was the first feature
whose output the format could not say.

It closed as `url` on an object and on a collection — a value, not the template
in `producer` that was the other candidate. A template is a construction rule,
and a consumer holding one builds addresses for objects that never traveled by
parsing and interpolating an id the format says is opaque. One string per object
costs bytes; a template costs the id rule.

Worth noting what the picker's own code showed on inspection: everything
upstream of it — the mirror, the search, the title resolver — runs on the
interchange read path and is producer-agnostic. Then `render()` emitted
`{origin}/block/{id}` and hardcoded Hermes at the final step. A feature can be
built correctly all the way through and still be locked to one producer by its
last line.

---

## What building it actually taught

Written down because none of it was in the design, and all of it changed the
design.

### The window manager is a query surface, not an event source

The plan was to subscribe to Rift and be told things. Measured, it does not work:
Rift's four events — `workspace_changed`, `windows_changed`,
`window_title_changed`, `stacks_changed` — all describe windows and workspaces,
and ⌘-Tab between two applications produces none of them. Meanwhile
`window_title_changed` fires when a terminal retitles itself for every command it
runs, so the one event that looked richest is mostly noise.

`rift-cli query workspaces` answers everything at once: the active workspace by
name, and the focused window's bundle id **and title**.

**The general rule, which cost a day to learn:** anything that arrives only by
event needs a way to be established at startup. A subscription tells you about
transitions and nothing about where you already are — so after every restart the
workspace was simply missing until the next time one happened to change. A
subscription is also a foreground process that dies with its terminal. A poll
over a query surface has neither problem and needs no wiring to survive a reboot.

### Window titles came back for free — and then had to be given back

The design gave up titles to avoid a fourth accessibility consumer, and called
that a real loss. Rift already holds the permission and returns a `title` in the
same query, so titles looked free.

**They were not, and the way this was got wrong is the most important thing in
this document.**

Rift's `title` is not a window title. It is the accessibility title of whatever
the window exposes as focused, and in a browser showing Gmail that is the message
pane. So `title` arrived as the **entire body of an email** — colleagues' full
names, addresses, direct phone numbers, budget account codes, whole forwarded
threads from people who have no idea this software exists. Third-party
correspondence, verbatim, on disk, within an hour of the feature shipping.

The evidence that it was safe was six windows from one `rift-cli query` — a
terminal, a Finder window, Claude, Messages. All native apps. Not one browser.
**The single class of application where the field means something completely
different was the class that was never sampled**, and it is the one the day is
mostly spent in. Earlier output had already shown `Labels` and `Formatting
options` from Chrome; both were read as harmless page titles rather than as the
symptom they were.

What replaced it: an **allowlist** of applications whose `title` has actually
been looked at, plus a hard length cap, because a real window title is short and
anything longer is a document's contents. Everything unverified contributes an
application name and a workspace.

The general rule, and it is not about window managers:

> **A blocklist over a field you do not control requires being right about every
> case in advance, forever. An allowlist requires being right about the cases you
> checked.** When the cost of being wrong is other people's data, only the second
> is defensible — and "I sampled it and it looked fine" is not the same as having
> checked, unless the sample contained the case that breaks it.

The cost is real: browsers are where most of the day happens, and they are dark
now. But the signal there was never worth much — `Send and archive (⌘Enter)` is
a focus artifact, not a subject.

Launch Services (`lsappinfo`) covers what Rift does not manage, and needs no
grant either. It has no title to give, which in hindsight was the safer of the
two all along.

### Resolve, then drop

The most transferable idea here, and it arrived as a privacy problem. A Messages
window title is the name of the person you are talking to — simultaneously one
of the strongest retrieval signals available, because Hermes has People and that
name resolves to a block, and a timestamped log of who you talk to and when.

Both are true and they are not in tension, because **the value is in the
resolution rather than in the string**. Look the title up: a hit is stored as a
block id, which ranks *better* than the name because an id is unambiguous where a
name is fuzzy. A miss is dropped, because a name that leads nowhere in your
library carries the whole cost and almost none of the benefit.

The matching is exact, case-insensitive, and refuses on ambiguity — the spec's
own stub argument, one layer down: name matching converges two writers onto one
roofer for free and gets two different Janes wrong.

### BetterTouchTool was demoted before it was ever installed

It was going to be the context sensor. Rift and Launch Services cover that
between them, from inside a process that already runs forever. BTT keeps the
surface work — floating menus, hotkeys — which is what it is best at and what
it can be replaced at.

### Everything in this stack fails silently

Seven failures during one afternoon of wiring, every one of which looked like
success from outside: a service that stopped itself after the accessibility
prompt; one unknown config key killing the daemon on parse while launchd left it
down; a config file sitting unread in the wrong directory while its settings
appeared to apply; a status item hidden behind a notch in space that looked
empty; three consecutive wrong guesses at an undocumented tool's output shape,
each one degrading to silence; and an in-memory workspace lost on every restart.

Not one was found by anything reporting it. All seven were found by a person
running a command by hand and reading the output.

That is the argument for the section above, and it is why `doctor` calls
`frontmostApp()` live on every run rather than inferring health from row counts:
a record that is empty because you have been in one application for an hour looks
exactly like one that is empty because the parser broke. **Anything in this stack
reading an undocumented or external surface gets asked directly, not inferred
from its output.**

### Still unanswered

The workspace is the only semantic signal available, and it is currently called
`first`. Whether workspace names become subject-shaped — `Roofing`, `Hermes`,
`School` — decides whether capabilities 2 through 5 have anything to stand on.
That is a habit question, not a code question, and a week of rows is what answers
it.

---

## Before committing

Four things, and the first can kill the design.

**Three applications competing for the accessibility tree.** BTT, Rift and
Talaria all want AX observers. This is a known source of beachballs and it is
empirical, not arguable.

**Rift against a floating panel.** The collections window opens on ⌃⌥B and closes
whatever it opened. Rift is pre-release, on private APIs reverse-engineered by
yabai, with no stable release. Whether it leaves a panel alone or needs a float
rule decides whether the board survives. Rift has an App Rules page in its wiki,
so a float rule keyed on bundle id is the likely answer.

**Forking Rift is a cost, not a shortcut.** The integration surface is already
richer than this document originally assumed, so the case for a fork is weak —
and the cost is not the code. Rift's entire job is tracking undocumented macOS
behavior through reverse-engineered private APIs, on a beta OS. Upstream is what
keeps those workarounds alive as the OS moves; a fork means re-earning that
forever. Contribute upstream instead — the project takes PRs, and anything
wanted here is plausibly wanted by the status-bar crowd too. If a fork happens at
all it should be a staging area with upstream as a remote.

**The rule, if it does happen:** a fork may teach Rift about *workspaces*. It may
never teach Rift about *blocks*. The temptation — "just have Rift call Hermes on
workspace switch" — is the thesis violation at the top of this document, arriving
by the door that looks most convenient.

**Window titles are the most revealing telemetry on the machine** — more than
browser history. If context observation persists at all it needs an exclusion
list, a rolling window, and an off switch reachable in one gesture. Designed in
at the start; retrofitted privacy is not privacy.

**BTT is closed-source, single-developer and license-gated.** Fine as a surface,
wrong as a place to keep logic. Everything it does should be a named trigger
calling `talaria`, so replacing it is a config change.

---

## Order

1. **The reference picker.** Shippable, needs nothing new.
2. **The context record.** One table in the mirror and a `talaria context`
   subcommand that BTT and Rift call. No intelligence yet.
3. **`doctor` for the stack.** Grows with 1 and 2 rather than after them.
4. **The ambient panel.** Needs the context record.
5. **Workspace binding.** After Rift proves stable enough to build on.
6. **The background agent.** Gated on create and tag-write, which is format work
   that is worth doing regardless.
