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
