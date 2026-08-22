#!/usr/bin/env bash
# Build, assemble and sign Talaria.app.
#
# The bundle is assembled OUTSIDE the repo, on purpose. This repo lives under
# ~/Documents, which is iCloud-managed, and codesign refuses anything carrying
# the extended attributes iCloud attaches — "resource fork, Finder information,
# or similar detritus not allowed". They cannot be cleared for long: the sync
# puts them back. Building somewhere unsynced makes the problem not exist rather
# than fighting it every time.
#
# swiftc rather than an Xcode project: one target, three files, no resources.
# Phase 3 (App Intents) needs the Xcode build system for its metadata extraction
# pass — that is the point at which this stops being enough.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="${TALARIA_APP:-$HOME/Library/Application Support/Talaria/Talaria.app}"

echo "==> Assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
sed "s|__REPO_ROOT__|$REPO_ROOT|" "$HERE/Info.plist" > "$APP/Contents/Info.plist"
# A bundle that can't find the daemon starts, logs, and serves nothing — so this
# is checked here rather than discovered as an empty Spotlight.
grep -q "__REPO_ROOT__" "$APP/Contents/Info.plist" && { echo "!! repo root not substituted"; exit 1; }
[ -f "$REPO_ROOT/packages/daemon/src/index.ts" ] || { echo "!! no daemon at $REPO_ROOT"; exit 1; }

echo "==> Icon"
# Needs Pillow. It is a build-time dependency on this machine only — nothing
# the daemon or the app depends on at runtime.
mkdir -p "$APP/Contents/Resources"
python3 "$HERE/make-icon.py" "$REPO_ROOT/../assets/HermesLogo.png" "$APP/Contents/Resources"
rm -rf "$APP/Contents/Resources/Talaria.iconset"

echo "==> Compiling"
xcrun swiftc \
  -O \
  -target arm64-apple-macos13.0 \
  -framework AppKit -framework CoreSpotlight -framework UniformTypeIdentifiers \
  -o "$APP/Contents/MacOS/Talaria" \
  "$HERE/Sources/Daemon.swift" "$HERE/Sources/Indexer.swift" "$HERE/Sources/main.swift"

echo "==> Signing (ad-hoc; personal machine, no notarization)"
codesign --force --sign - --identifier dev.talaria.Talaria "$APP"
codesign --verify --strict "$APP"

echo "==> Registering with LaunchServices (so talaria:// routes here)"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "$APP"

echo "built $APP"
