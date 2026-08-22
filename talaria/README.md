# Talaria

A macOS system-integration layer for [Hermes Notes](../README.md): it keeps a
local mirror of your blocks so the rest of the operating system can find and act
on them, whether or not the home server is reachable.

**Phase 1 (daemon, mirror, CLI) works.** Phases 2 (Spotlight, `hermes://`) and 3
(App Intents) are not built yet. See [DESIGN.md](DESIGN.md) for what was decided
and why, and [HERMES-CORE-CHANGES.md](HERMES-CORE-CHANGES.md) for everything this
asks of Hermes proper.

## What exists

```
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
cp talaria/launchd/dev.talaria.daemon.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.talaria.daemon.plist
```

Restart it after pulling changes:

```bash
launchctl kickstart -k gui/$(id -u)/dev.talaria.daemon
```

Logs go to `~/Library/Logs/talaria.log`. It restarts whatever stops it, so
`kill` won't hold — to actually stop it:

```bash
launchctl bootout gui/$(id -u)/dev.talaria.daemon
```

A bad config therefore respawns rather than staying down; `ThrottleInterval`
holds that to one attempt a minute so the error stays readable in the log.

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
