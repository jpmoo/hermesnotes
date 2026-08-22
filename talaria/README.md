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

Then copy the example config into place and fill in the key:

```bash
mkdir -p ~/Library/Application\ Support/Talaria
cp talaria/config.example.json ~/Library/Application\ Support/Talaria/config.json
chmod 600 ~/Library/Application\ Support/Talaria/config.json
```

| field | required | what it is |
|---|---|---|
| `origin` | yes | Where Hermes lives, up to but **not** including `/api`. The daemon appends `/api/...` itself, so `https://host/hermesnotes` becomes `https://host/hermesnotes/api/sync/blocks`. No trailing slash needed. |
| `accessKey` | yes | A Hermes access key — **Settings → Access keys** in the web app. Shown once when minted. The daemon reads it and nothing else does; it never leaves this machine except as a bearer header to `origin`. |
| `pollSeconds` | no (default 30) | How often to ask for changes while the network is up. Backs off automatically when it isn't, up to 15 minutes, so a laptop on a dead hotel network doesn't hammer. |

The file is read at startup only — restart the daemon after editing it. `chmod
600` matters: it holds a key that can read and write everything in your account.

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

- **Add to Hermes as Task** — first line becomes the title, the rest goes into
  the type's prose field (and into the title, if the type hasn't got one, rather
  than being dropped)
- **Add to Hermes as Note** — the whole selection, as a text block

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

**⌃⌥Space** opens a prompt anywhere. It talks to the Hermes assistant, which
runs on your server against your own Ollama model, so this is **the one thing
here that needs the network** — everything else answers from the mirror. When it
can't be reached it says so rather than spinning.

Anything destructive comes back for approval before it runs: the panel lists
what it wants to do and does nothing until you say. `"assistantHotkey"` in
`config.json` rebinds it.

## Collections

**Any** collection in a floating window, styled from the web app's own palette:

- **matrix / kanban** — the grid, with cards draggable between regions and a
  drawer for what the query matched but nobody placed
- **canvas** — read-only, at the coordinates the web app placed things at, with
  the sticky notes and the connections. Pan, zoom, click to open. Nothing is
  moved from here: a canvas is a spatial argument someone made on purpose.
- **calendar** — an agenda: the next fortnight, day by day, merging dated
  blocks with your calendar-feed events. Feed events wear their feed's colour;
  per-type pills persist; completed things sink and mute. Feed events are
  cached, so a lost connection gives you yesterday's copy and says so rather
  than an empty week.
- **everything else** — list, table, rollup, masonry — as a sequence.
  Deliberately one renderer rather than four near-misses.

The calendar is an agenda rather than a month grid on purpose: the web app's
calendar has four range modes, an all-day band and multi-day lanes because it
has a screen to spend. In a panel the useful question is "what's coming".

The picker names each collection's kind with its icon, and remembers the last
one. Right-click the menu bar item to choose whether a plain click opens the
collections window or Ask Hermes.

Cards drag between regions **and to and from the drawer** — dragging one out of
the drawer is the moment it joins the collection, and dropping one back takes it
out of the grid without taking it out of the collection.

Two ways in. **⌃⌥B** opens it from anywhere; the menu bar item does the same.
Set `"boardHotkey"` in `config.json` to change it (e.g. `"cmd+shift+h"`); it
takes effect on the next app restart. ⌃⌥Space is deliberately left free.

The menu bar uses an SF Symbol, not the logo: the mark is line art that draws
eleven meaningful pixels at 18 points, and thickened enough to see it becomes a
blob. `"menuBarSymbol"` in `config.json` picks a different one.

The second entrance is not a convenience: macOS drops status items that don't
fit, and on a Mac with a notch and a busy menu bar ours is the newest and so the
first to go. It ends up behind the `<<` overflow, which is fine — but an
entrance that can quietly move is not one to rely on alone.

Why a window and not a widget: a widget renders snapshots and accepts taps, with
no drag, no drop and no scroll — and dragging between quadrants is most of what
a matrix is for. A window also reaches the daemon socket directly, with no
sandbox, App Group or entitlement in the way, and needs no App Intents.

## Spotlight and links

The app indexes the mirror into CoreSpotlight, so ⌘Space finds your blocks and
opens them. It reindexes when the daemon's cursor moves, not on a timer.

`talaria://block/<uuid>` opens a block; `talaria://collection/<uuid>` opens a
collection. Paste one anywhere that linkifies URLs, or `open talaria://block/…`
from a terminal.

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
