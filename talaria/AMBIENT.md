# Ambient — the desktop as a PKM surface

**Status:** design brief. Nothing here is built.
**Scope:** what Talaria becomes when BetterTouchTool, Rift and a local inference
box join it. Written in the same spirit as `DESIGN.md`: decisions with the
reasoning attached, open questions named rather than resolved early.

---

## The thesis

`packages/canonical` exists because a seam that is merely documented leaks by
week three. The same rule has to hold one level further out:

> **BetterTouchTool and Rift are sensors and surfaces. They are never clients of
> Hermes.** Everything reaches the library through the Talaria socket, and
> Talaria speaks nothing but `pkm-interchange` to the server.

The failure mode is specific and it is what every "I wired my Mac to my notes"
setup becomes: a BTT script that curls a Hermes route, a Rift handler that curls
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
| **Rift** | **the context sensor**, and arrangement | JSON-over-Mach IPC. `rift-cli query workspaces\|windows\|displays` reads state; `rift-cli execute workspace switch N` arranges; `rift-cli subscribe cli --event … --command …` runs a command on `workspace_changed`, `windows_changed`, `window_title_changed`, `stacks_changed` |
| **BetterTouchTool** | **surface**, and the apps Rift does not manage | floating menus host a webview; hotkeys; conditional activation groups for anything outside a managed window |
| **Alfred** | one more search entrance | already fed by `talaria alfred`; nothing new required |
| **Talaria** | **the bus** | socket, mirror, FTS, queue, URL scheme, `doctor` — all of it already exists |
| **Local inference box** | the thing that runs when nobody is asking | lives on the LAN where Hermes lives, not on the Mac |

**Rift is the sensor, not BTT.** An earlier draft of this document had it the
other way round, on the assumption that window titles were BTT's to observe.
They are not: Rift emits `window_title_changed` natively and its subscription
mode runs an arbitrary command with event data in the environment. Which means
the sensor wiring is

```
rift-cli subscribe cli --event window_title_changed --command talaria --args context set
```

and there is no glue at all. The thesis above — *sensors call `talaria`* — turns
out to be the shape Rift already ships.

BTT keeps the surface work, which is what it is actually best at, plus context
for windows Rift is not managing.

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
| 1 | **There is no create** | proposing anything at all |
| 2 | **There is no tag write** | filing what was proposed |
| 3 | **An object has no address** | every surface that links |
| 4 | `derivations` names the feature, not the query | re-evaluating a smart collection |
| 5 | No sort or grouping on a collection | rendering a board as arranged |

The first three are small. `PUT` an object at a client-chosen id, which makes
creation idempotent by construction and needs no new concepts;
`addTags`/`removeTags` on the patch; a `url` on an object or a template in
`producer`, with the id staying opaque either way.

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
behaviour through reverse-engineered private APIs, on a beta OS. Upstream is what
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
