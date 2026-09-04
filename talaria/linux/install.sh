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

echo "==> Up. Checking:"
exec "$ROOT/bin/talaria" doctor
