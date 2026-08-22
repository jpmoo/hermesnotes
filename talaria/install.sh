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

echo "==> Signing the app bundle (ad-hoc; personal machine, no notarization)"
# codesign refuses anything carrying extended attributes: "resource fork, Finder
# information, or similar detritus not allowed". This repo lives under
# ~/Documents, which is iCloud-managed, so the bundle collects com.apple.
# FinderInfo and com.apple.fileprovider.* on its own — and collects them again
# after every sync. Clearing them immediately before signing is the only thing
# that stays true.
xattr -cr "$ROOT/app/Talaria.app"
rm -rf "$ROOT/app/Talaria.app/Contents/_CodeSignature"
codesign --force --sign - --identifier dev.talaria.Talaria "$ROOT/app/Talaria.app"

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
SOCK="$HOME/Library/Application Support/Talaria/talaria.sock"
for _ in $(seq 1 50); do [ -S "$SOCK" ] && break; sleep 0.2; done
[ -S "$SOCK" ] || { echo "!! no socket after 10s — see ~/Library/Logs/talaria.log"; exit 1; }
echo "==> Up. Checking:"
exec "$ROOT/bin/talaria" doctor
