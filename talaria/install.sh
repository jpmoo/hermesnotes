#!/usr/bin/env bash
# Install (or reinstall) the Talaria LaunchAgent.
#
# Exists because the obvious one-liner doesn't work: `bootout` returns before
# the old process has finished exiting, and bootstrapping the same label while
# it is still tearing down fails with "Bootstrap failed: 5: Input/output error".
# So this waits for the label to actually go away before bringing it back.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
LABEL="dev.talaria.daemon"
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

echo "==> Building, signing and registering the app"
"$ROOT/app/build.sh"

echo "==> Installing $PLIST"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cp "$ROOT/launchd/$LABEL.plist" "$PLIST"

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  echo "==> Stopping the running agent"
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  for _ in $(seq 1 50); do
    launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
    sleep 0.2
  done
fi

echo "==> Starting"
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl kickstart "$DOMAIN/$LABEL"

echo "==> Waiting for the socket"
# Measured at about eleven seconds from bootout to listening: launchd takes a
# few to bring the app back, and the daemon spends a few more compiling
# TypeScript on the way up. Ten was just short enough to report a failure that
# had not happened.
SOCK="$HOME/Library/Application Support/Talaria/talaria.sock"
for _ in $(seq 1 150); do [ -S "$SOCK" ] && break; sleep 0.2; done
[ -S "$SOCK" ] || { echo "!! no socket after 30s — see ~/Library/Logs/talaria.log"; exit 1; }
echo "==> Up. Checking:"
exec "$ROOT/bin/talaria" doctor
