# Talaria

A macOS system-integration layer for [Hermes Notes](../README.md): it keeps a
local mirror of your blocks so the rest of the operating system can find and act
on them, whether or not the home server is reachable.

**Phases 1 and 2 work.** Phase 3 (App Intents) is not built yet. See [DESIGN.md](DESIGN.md) for what was decided
and why, and [HERMES-CORE-CHANGES.md](HERMES-CORE-CHANGES.md) for everything this
asks of Hermes proper.

## What exists

```
app/                 Talaria.app — Spotlight indexing, the talaria:// scheme
alfred/              an Alfred workflow, since Alfred can't see CoreSpotlight
packages/canonical   the seam — the only code that sees a Hermes payload
packages/daemon      local SQLite mirror, sync loop, Unix-socket server
packages/cli         the `hermes` command
acceptance/          an end-to-end scenario, including pulling the network out
launchd/             a LaunchAgent plist
```

## Setting it up

Hermes needs the `/sync/*` routes, so deploy the server first (`./restart.sh` on
the host).

Then tell it where Hermes is. Right-click Talaria's menu bar icon → **Settings…**
(or `open talaria://settings` from anywhere). Paste the address and an access
key, press **Test connection** to check both before saving, and Save — which
writes the file below and restarts the daemon.

The panel is the only setup step. Everything in the table is reachable from it,
and the file is written for you at mode 600.

<details>
<summary>Or write it by hand</summary>

```bash
mkdir -p ~/Library/Application\ Support/Talaria
cp talaria/config.example.json ~/Library/Application\ Support/Talaria/config.json
chmod 600 ~/Library/Application\ Support/Talaria/config.json
```

</details>

| field | required | what it is |
|---|---|---|
| `origin` | yes | Where Hermes lives, up to but **not** including `/api`. The daemon appends `/api/...` itself, so `https://host/hermesnotes` becomes `https://host/hermesnotes/api/sync/blocks`. No trailing slash needed. |
| `accessKey` | yes | A Hermes access key — **Settings → Access keys** in the web app. Shown once when minted. The daemon reads it and nothing else does; it never leaves this machine except as a bearer header to `origin`. |
| `pollSeconds` | no (default 30) | How often to ask for changes while the network is up. Backs off automatically when it isn't, up to 15 minutes, so a laptop on a dead hotel network doesn't hammer. |
| `glanceUrl` | no (default `http://localhost:11434`) | Where Glance embeds what you are working on. **Local is the point, not just the default** — the text of your front window goes to whatever is at this address. The panel says plainly which of the two you have chosen. |
| `glanceModel` | no (default `nomic-embed-text:latest`) | Which model does the embedding. Only has to agree with itself: Glance keeps its own index, so changing this throws those vectors away and rebuilds rather than breaking anything. The panel lists what the server actually has installed, and filters to the ones that can embed. |

The file is read at startup only. Saving from the settings panel restarts the
daemon for you; editing by hand does not, so restart it yourself after. `chmod
600` matters either way: it holds a key that can read and write everything in
your account. The panel writes it that way and puts it back on every save.

Saving is an overlay, never a rewrite — anything in the file the panel does not
know about survives untouched.

Then:

```bash
pnpm --filter @talaria/daemon start
```

The first run walks the whole account; after that it follows the change log.
Check it landed with:

```bash
talaria doctor
```

which reports the config, the socket, whether Hermes is reachable **and**
accepting the key, how old the mirror is, and anything parked in the write
queue — all things that otherwise fail silently.

## Using it

The command is `talaria`, not `hermes` — that name already belongs to Hermes
Agent (Nous Research) on this machine. It's a script rather than a shell alias so
Shortcuts, Raycast and launchd can all reach it; none of those read your
`.zshrc`.

```bash
ln -s "$PWD/talaria/bin/talaria" ~/.local/bin/talaria   # ~/.local/bin is already on PATH

talaria find roofer              # search the mirror
talaria find --kind task         # by kind
talaria show <id>                # one block in full
talaria add "Ring the plumber"   # create a task
talaria done <id>                # complete one
talaria note "thought for today" # append to today's daily note
talaria queue                    # writes waiting on the network
talaria doctor                   # everything that fails quietly, asked out loud
```

**Reads never touch the network.** They are answered from `mirror.sqlite`, so
they work with the machine entirely offline — and any answer that isn't current
says how old it is. Writes go out immediately when Hermes is reachable and queue
when it isn't; a task created offline gets its real id straight away, so it is
findable and linkable before it has ever reached a server.

## Running it as a background service

```bash
./talaria/install.sh
```

Signs the bundle, installs the plist, restarts cleanly if it's already running,
waits for the socket and then runs `talaria doctor`. Re-run it after pulling
changes — it is the restart.

The daemon runs from `app/Talaria.app` rather than straight from node, so that
System Settings › Login Items calls it **Talaria** instead of **Node**: macOS
names a background item after the app responsible for it, and a bare executable
has no app to be responsible. The same bundle is what CoreSpotlight will need in
Phase 2.

Logs go to `~/Library/Logs/talaria.log`. It restarts whatever stops it, so
`kill` won't hold — to actually stop it:

```bash
launchctl bootout gui/$(id -u)/dev.talaria.daemon
```

A bad config therefore respawns rather than staying down; `ThrottleInterval`
holds that to one attempt a minute so the error stays readable in the log.

## The icon

`app/Talaria.icon` is an Icon Composer document, and it is what the build
prefers. macOS 26 treats a bare `.icns` — or a hand-built asset catalog — as a
legacy icon and wraps it: the artwork is shrunk and drawn inside a container of
its own, which is the frame that then badges every Spotlight result. An Icon
Composer document is rendered natively, full bleed, with the system deriving the
light, dark and tinted variants.

One trap worth writing down: the `.icon` goes to `actool` **directly**. Put it
inside an `.xcassets` the way an image set would go and it compiles silently to
nothing at all — no error, no output, no icon.

To change the artwork, open `Talaria.icon` in Icon Composer (inside Xcode) and
rebuild. `app/glyph-1024.png` is the mark on its own, if you need to start over.

## Capturing from any app

Select text anywhere, right-click, and under **Services**:

- **Add to Hermes Notes as Task** — first line becomes the title, the rest goes into
  the type's prose field (and into the title, if the type hasn't got one, rather
  than being dropped)
- **Add to Hermes Notes as Note** — the whole selection, as a text block

Both work offline: the block is created locally with its real id and goes out on
reconnect. A notification says which happened.

If the items don't appear, macOS caches Service declarations — `build.sh` flushes
that cache, but a stubborn menu is fixed by logging out and back in. They can be
turned off individually in System Settings › Keyboard › Keyboard Shortcuts ›
Services.

The same capture is available anywhere else:

```bash
pbpaste | talaria capture          # as a task
pbpaste | talaria capture --note   # as a note
```

## Ask Hermes

**⇧⌥A** opens a prompt anywhere. It talks to the Hermes assistant, which
runs on your server against your own Ollama model, so this is **the one thing
here that needs the network** — everything else answers from the mirror. When it
can't be reached it says so rather than spinning.

Anything destructive comes back for approval before it runs: the panel lists
what it wants to do and does nothing until you say. Settings → **Shortcuts**
rebinds it.

## New blocks

**⇧⌥H** opens a composer. Pick a type and fill in its fields.

The panel contains no idea of what a Task is. It draws itself from what
`/types` declares — every field carries its own `kind`, `label` and options, so
a text field, a status, a date span and a reference picker all appear because
the *type* said so. Rename a type, add a field, and the form follows; write
`if typeName == "Task"` and it is wrong the first time somebody does either.

Recurrence and attachments are named in the panel and deliberately not offered.
A malformed recurrence is a block that spawns wrong occurrences forever, which
is a good deal worse than a field you finish on the web.

This is the one surface that goes through Hermes' own API rather than the
interchange binding, because the format has no `create` verb yet — see
`pkm-interchange/LIMITS.md`. It still writes through the queue, so a block
composed on a train exists locally and is sent on reconnect.

## Collections

**Any** collection in a floating window, styled from the web app's own palette:

- **matrix / kanban** — the grid, with cards draggable between regions and a
  drawer for what the query matched but nobody placed. A region's actions apply
  on the way in: its tag is added, its status is set if it sets one, and the tag
  of the region left behind is removed when that region asked for it. Moving a
  card into "Do" without it becoming `#do` would make the board a picture of an
  arrangement rather than the arrangement itself.
- **canvas** — read-only, at the coordinates the web app placed things at, with
  the sticky notes and the connections. Pan, zoom, click to open. Nothing is
  moved from here: a canvas is a spatial argument someone made on purpose.
- **calendar** — an agenda that scrolls forward from today, day by day, merging
  dated blocks with your calendar-feed events. There is nothing to click to see
  next week; it is further down. Days with nothing on them are left out. Feed events wear their feed's colour;
  per-type pills persist; completed things sink and mute. Feed events are
  cached, so a lost connection gives you yesterday's copy and says so rather
  than an empty week.
- **rollup** — a heading per bucket with what hangs under it. A rollup owns no
  memberships at all; it is resolved from its roots and levels.
- **table** — the columns it was configured with, from `table_columns`,
  including a datespan split into its two legs. Drawn as a list of titles it
  stops being a table; the columns are the point of choosing that shape.
- **everything else** — list, masonry — as a sequence.

Grouped collections show a heading per bucket, and the headings collapse. Which
are shut is remembered per collection, because a board you have to re-collapse
every time you open it is one you stop collapsing.

The calendar is an agenda rather than a month grid on purpose: the web app's
calendar has four range modes, an all-day band and multi-day lanes because it
has a screen to spend. In a panel the useful question is "what's coming".

The picker names each collection's kind with its icon, and remembers the last
one. Right-click the menu bar item to choose whether a plain click opens the
collections window or Ask Hermes.

Cards drag between regions **and to and from the drawer** — dragging one out of
the drawer is the moment it joins the collection, and dropping one back takes it
out of the grid without taking it out of the collection.

Two ways in. **⇧⌥C** opens it from anywhere; the menu bar item does the same.
Settings → **Shortcuts** changes it (e.g. `cmd+shift+h`), and the new binding
takes effect on Save rather than on the next restart.

The three defaults are ⇧⌥C, ⇧⌥A and ⇧⌥G. Option is macOS's compose modifier,
which sounds like a reason to avoid it and isn't: a shortcut that registers
swallows the keystroke, so nothing is composed. The case that bites is a
combination something *else* already owns — then the key falls through and
types a dead-key character into whatever you were writing. That refusal is
logged, by name, in `~/Library/Logs/talaria.log`.

The menu bar uses an SF Symbol, not the logo: the mark is line art that draws
eleven meaningful pixels at 18 points, and thickened enough to see it becomes a
blob. Settings → **Shortcuts** → *Menu bar icon* picks a different one, by SF
Symbol name.

The second entrance is not a convenience: macOS drops status items that don't
fit, and on a Mac with a notch and a busy menu bar ours is the newest and so the
first to go. It ends up behind the `<<` overflow, which is fine — but an
entrance that can quietly move is not one to rely on alone.

Why a window and not a widget: a widget renders snapshots and accepts taps, with
no drag, no drop and no scroll — and dragging between quadrants is most of what
a matrix is for. A window also reaches the daemon socket directly, with no
sandbox, App Group or entitlement in the way, and needs no App Intents.

## Hermes in a window

Talaria carries its own `WKWebView` window. **Open Hermes** in the menu bar
item's right-click menu, or click anything anywhere in Talaria — a card, a
Spotlight result, a `talaria://` link — and it lands there rather than in a
browser tab.

Opening anything closes the panel that offered it — a panel is a way of getting
somewhere, and once you have gone it should not sit behind what it opened. A
calendar-feed event has no address of its own, so it opens the calendar it
belongs to.

Links *out* of Hermes still go to the default browser: someone else's website
belongs in a browser, and the distinction is the whole reason the window exists.

The session persists on disk, so logging in is a one-off.

Talaria is a normal foreground application: it has a Dock tile you can pin, an
Edit menu, and it shows in ⌘-Tab. It was an accessory app that flipped policy
when a window opened, and that half-worked — a menu bar drawn at runtime never
properly attaches, and an auto-hiding Dock won't reveal itself over the windows
of an app it doesn't consider normal.

Clicking the Dock tile opens the Hermes window even though the app is already
running, which it always is — launchd starts it at login.

This replaces pointing deep links at a Nativefier wrapper. That build receives
`open-url` and forwards it to a renderer with no listener for it, so links
arrive and vanish; its `second-instance` handler ignores argv too. Registering a
scheme against it would have raised the window and discarded the link.

## Spotlight and links

The app indexes the mirror into CoreSpotlight, so ⌘Space finds your blocks and
opens them. It reindexes when the daemon's cursor moves, not on a timer.

`talaria://block/<uuid>` opens a block; `talaria://collection/<uuid>` opens a
collection. Paste one anywhere that linkifies URLs, or `open talaria://block/…`
from a terminal.

Every surface has a name too, which is the only way to reach one from a script,
a Shortcut or an Alfred keyword — a hotkey is not addressable, and the menu bar
item is something macOS will drop when the bar is full:

| | |
|---|---|
| `talaria://collections` | the collections window (also `board`) |
| `talaria://chat` | Ask Hermes (also `assistant`, `ask`) |
| `talaria://glance` | Glance |
| `talaria://settings` | the settings panel |

The first three toggle, so the URL and the hotkey do the same thing rather than
two subtly different ones. Settings only ever opens.

Why a custom scheme when the https link already works: **the https link names a
host**, so every one ever pasted dies the day Hermes moves. A `talaria://` link
is resolved by the daemon at click time out of the one config file that knows
where Hermes lives. The canonical object carries both — `url` to share, `appUrl`
for here.

Spotlight does **not** go through the scheme: activating a result calls the app
back with the item's identifier, which for us is the block UUID.

Checking the index without ⌘Space — CoreSpotlight items are invisible to
`mdfind`, which searches a different store entirely:

```bash
"$HOME/Library/Application Support/Talaria/Talaria.app/Contents/MacOS/Talaria" --search "dual enrollment"
```

`--index` forces a reindex and `--clear` empties it.

## Alfred (and anything else that isn't Spotlight)

**Alfred cannot see CoreSpotlight items.** Its search is built on the file
metadata index, and app content indexed through `CSSearchableIndex` lives in a
different store entirely — which is why ⌘Space finds a block and `mdfind`
returns nothing for it. The same is true of Raycast's file search, LaunchBar, and
anything else built on `mdfind`.

So Alfred is fed directly rather than through the system index:

```bash
./talaria/alfred/build.sh && open talaria/alfred/Talaria.alfredworkflow
```

Then `hn <anything>` in Alfred. Return opens the block in the web app;
Cmd-Return opens it via `talaria://`.

**Alfred's own search will not find these, and cannot be made to.** Its default
results are files, apps and contacts drawn from the macOS metadata index; app
content indexed through CoreSpotlight is a separate store with no injection
point (`showDocuments` / `showFolders` / `showTextFiles` is the whole of what
that pane configures). So a keyword is not a shortcut here — it is the mechanism.

The workflow also ships a **Fallback Search**, which is as close as Alfred gets
to inline: add it under *Preferences → Features → Default Results → Setup
fallback results*, and "Search Hermes for …" appears whenever nothing on the Mac
matches what you typed. Actioning it opens the best match.

The only way to reach Alfred's *default* results would be to write each block to
disk as a real file, in a folder the metadata index covers — see DESIGN.md §1.7a.

The workflow calls `talaria alfred "$1"`, which emits Script Filter JSON. Any
launcher that can run a command and read JSON can use the same call — the
integration is one command, not one plugin per launcher.

## Running the acceptance scenario

```bash
bash talaria/acceptance/run.sh
```

It stands up a stub Hermes, syncs a daemon against it, **kills the stub**,
verifies that reads still work and writes queue, brings it back, and checks that
exactly one block and exactly one appended line arrive — including on a replayed
create, which is the lost-response case.

The stub deliberately mirrors Hermes' real quirks (a missing `blockTypeId`
resolves to the *text* type, which discards properties). It was made faithful
after being unfaithful hid a genuine bug.
