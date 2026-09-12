#!/usr/bin/env bash
# Install (or reinstall) the Talaria user unit, and prove it came up.
#
# The macOS sibling exists because `launchctl bootout` returns before the
# process has gone. systemd does not have that problem — `systemctl --user
# restart` waits — so this script is not a workaround. It is here for the two
# things the plist install could not do either: resolve node into an absolute
# ExecStart, and finish by asking the socket whether any of it worked.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/talaria.service"

# Everything that can fail, first.
#
# `build.sh` once wrote its output before compiling, so a compile failure left
# every visible sign of a good build and an untouched binary. The lesson
# generalizes past builds: nothing here is installed or started until the things
# it depends on have been shown to exist.

NODE="${TALARIA_NODE:-}"
if [ -z "$NODE" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.local/bin/node" /usr/bin/node; do
    [ -x "$candidate" ] && NODE="$candidate" && break
  done
fi
[ -n "$NODE" ] || NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "!! no node found — install Node 22, or set \$TALARIA_NODE"; exit 1; }

# The major version, not the string: tsx and the daemon's top-level await both
# want 22 or better, and a 24 that works should not be rejected for not being 22.
MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$MAJOR" -ge 22 ] || { echo "!! $NODE is v$MAJOR — Talaria needs 22 or newer"; exit 1; }

TSX="$ROOT/packages/daemon/node_modules/tsx/dist/cli.mjs"
[ -f "$TSX" ] || { echo "!! no tsx at $TSX — run 'pnpm install' at the repo root first"; exit 1; }

# The canvas is a build, and a build that nothing runs is a build that goes
# stale. Its output is committed — a fresh clone has a working canvas without a
# toolchain — but the moment somebody edits `canvas/src` the two disagree, and
# the disagreement is invisible: the old bundle loads perfectly well.
#
# Built here, before anything is installed or started, which is this script's own
# rule: "nothing here is installed or started until the things that can fail have
# been tried."
CANVAS_BUILD="$ROOT/linux/canvas/node_modules/.bin/vite"
CANVAS_TSC="$ROOT/linux/canvas/node_modules/.bin/tsc"
if [ -x "$CANVAS_BUILD" ]; then
  # **Typecheck before building, because the build does not.**
  #
  # `vite build` transpiles and never checks, so the fork shipped two handlers
  # bound to identifiers that do not exist anywhere — "Save…" threw on every
  # click and double-clicking bare canvas threw on every double-click, for as
  # long as each had been there. `tsc --noEmit` names that class of thing in one
  # line. It is a hard failure: a canvas that compiles to a ReferenceError is
  # not a canvas that built.
  if [ -x "$CANVAS_TSC" ]; then
    echo "-- checking the canvas"
    ( cd "$ROOT/linux/canvas" && "$CANVAS_TSC" --noEmit -p tsconfig.json ) \
      || { echo "!! the canvas does not typecheck"; exit 1; }
  fi
  echo "-- building the canvas"
  ( cd "$ROOT/linux/canvas" && "$CANVAS_BUILD" build >/dev/null ) \
    || { echo "!! the canvas would not build"; exit 1; }
else
  echo "-- no vite in linux/canvas; leaving the committed canvas bundle as it is"
fi
[ -f "$ROOT/packages/daemon/src/index.ts" ] || { echo "!! no daemon at $ROOT"; exit 1; }

echo "==> node:  $NODE (v$("$NODE" -p 'process.versions.node'))"
echo "==> unit:  $UNIT"

mkdir -p "$UNIT_DIR"
sed -e "s|__NODE__|$NODE|g" -e "s|__ROOT__|$ROOT|g" "$ROOT/linux/systemd/talaria.service.in" > "$UNIT"
# A template that failed to substitute produces a unit systemd will accept and
# an ExecStart that cannot run, which reads as a daemon that will not start
# rather than as an install that did not finish.
! grep -q "__NODE__\|__ROOT__" "$UNIT" || { echo "!! unit template not fully substituted"; exit 1; }

systemctl --user daemon-reload
systemctl --user enable talaria.service >/dev/null

# `restart` rather than stop-then-start, and it matters more here than it looks.
# A dying daemon once deleted the socket its successor had just bound, leaving a
# live process listening on an inode with no name. The daemon guards that
# itself now, but overlapping two of them is the condition that produced it, and
# `restart` is the one form that does not.
echo "==> Starting"
systemctl --user restart talaria.service

# What "up" means. `systemctl is-active` reports on a process, and a process
# proves nothing — the daemon's whole job is the socket, so the socket is what
# gets asked.
SOCK="${TALARIA_SOCKET:-${XDG_DATA_HOME:-$HOME/.local/share}/talaria/talaria.sock}"
echo "==> Waiting for $SOCK"
for _ in $(seq 1 150); do
  [ -S "$SOCK" ] && curl -sf --max-time 2 --unix-socket "$SOCK" http://talaria/health >/dev/null && break
  # A unit that has already given up will never bind, so stop waiting for it.
  if systemctl --user is-failed --quiet talaria.service; then
    echo "!! the daemon exited. Its own words:"
    journalctl --user -u talaria -n 30 --no-pager -o cat
    exit 1
  fi
  sleep 0.2
done

if ! curl -sf --max-time 2 --unix-socket "$SOCK" http://talaria/health >/dev/null 2>&1; then
  echo "!! no answer on $SOCK after 30s — journalctl --user -u talaria"
  exit 1
fi

# --- KDE's search box -------------------------------------------------------
#
# One file, naming a D-Bus service the shell answers on. Installed only on a
# Plasma session, because on anything else it is a file nothing will ever read.
#
# Unlike the autostart entry — which `dev.talaria.shell.desktop.in` deliberately
# leaves to the person whose desktop it is — this changes nothing until Talaria
# is running and somebody types something. It goes in.
if [ "${XDG_CURRENT_DESKTOP:-}" = "KDE" ] || [ -n "${KDE_FULL_SESSION:-}" ]; then
  RUNNERS="${XDG_DATA_HOME:-$HOME/.local/share}/krunner/dbusplugins"
  ICONS="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps"
  mkdir -p "$RUNNERS" "$ICONS"
  cp "$ROOT/linux/shell/dev.talaria.runner.desktop" "$RUNNERS/"
  # So the result row carries a mark rather than a blank square. Same file the
  # tray uses; the theme wants it under a name it can look up.
  cp "$ROOT/linux/shell/icons/talaria-symbolic.svg" "$ICONS/"
  echo "==> KRunner: installed $RUNNERS/dev.talaria.runner.desktop"
  # KRunner reads that directory once, at startup. It comes straight back.
  if command -v kquitapp6 >/dev/null 2>&1; then
    kquitapp6 krunner >/dev/null 2>&1 || true
    echo "    (restarted krunner so it picks the plugin up)"
  else
    echo "    (run 'kquitapp6 krunner' once, or log out, before it appears)"
  fi
fi

# --- Hyprland ---------------------------------------------------------------
#
# Two things this session needs that Plasma does not, and neither can be done
# to somebody's config behind their back.
#
# The hotkeys: both desktops bind through the GlobalShortcuts portal, but KDE's
# portal asks you to press a key and keeps the binding, while Hyprland's leaves
# the key to the compositor's own config. So one `bind` line per shortcut has to
# exist in hyprland.conf, naming the same action ids Talaria registers.
#
# The start: Hyprland does not read XDG autostart entries, so nothing starts the
# shell at login unless the config says so.
#
# Both are written to a file of our own and sourced by one line the user adds
# once. `hyprland.conf` is theirs — and Omarchy and Ryoku assemble it
# differently, one in Hyprland's own syntax and one in Lua — so a tool that
# edits it is a tool that will eventually eat somebody's setup.
if [ -n "${HYPRLAND_INSTANCE_SIGNATURE:-}" ] || [ "${XDG_CURRENT_DESKTOP:-}" = "Hyprland" ]; then
  HYPR_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/hypr"
  SNIPPET="$HYPR_DIR/talaria.conf"
  SHELL_BIN="$ROOT/linux/shell/talaria-shell"
  mkdir -p "$HYPR_DIR"
  if "$SHELL_BIN" --hypr-binds > "$SNIPPET.new" 2>/dev/null; then
    {
      echo
      echo "# Start the shell with the session."
      echo "#"
      echo "# Through systemd-run rather than directly: the portal names a"
      echo "# non-sandboxed app after the process that launched it, so a shell"
      echo "# started as a child of the compositor files its hotkeys under the"
      echo "# compositor and they are bound to nothing. This has been diagnosed"
      echo "# three times on the other desktop."
      echo "exec-once = systemd-run --user --scope --unit=app-dev.talaria.shell -- $SHELL_BIN"
    } >> "$SNIPPET.new"
    mv "$SNIPPET.new" "$SNIPPET"
    echo "==> Hyprland: wrote $SNIPPET"
    echo "    Add this line to hyprland.conf once, then run 'hyprctl reload':"
    echo "        source = $SNIPPET"
  else
    rm -f "$SNIPPET.new"
    echo "!! Hyprland: couldn't work out the hotkey lines (is PySide6 installed?)"
    echo "   Talaria will still run; its hotkeys will not be bound to anything."
  fi
fi

echo "==> Up. Checking:"
exec "$ROOT/bin/talaria" doctor
