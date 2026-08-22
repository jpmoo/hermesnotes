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
the host). Then, on this Mac:

```bash
mkdir -p ~/Library/Application\ Support/Talaria
cat > ~/Library/Application\ Support/Talaria/config.json <<'JSON'
{ "origin": "https://your-hermes/hermesnotes", "accessKey": "hn_…" }
JSON
chmod 600 ~/Library/Application\ Support/Talaria/config.json
```

Mint the key in Hermes under **Settings → Access keys**. Then:

```bash
pnpm --filter @talaria/daemon start
```

The first run walks the whole account; after that it follows the change log.

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
