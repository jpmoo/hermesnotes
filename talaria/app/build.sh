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
FINAL="${TALARIA_APP:-$HOME/Library/Application Support/Talaria/Talaria.app}"
# Assembled beside the real one and swapped at the end, never rebuilt in place.
# A Dock item points at a path: emptying that path and refilling it leaves a
# window in which the Dock can find nothing there and quietly drop the tile —
# and a half-written bundle is something launchd might get to first.
APP="$FINAL.building"

echo "==> Assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
sed "s|__REPO_ROOT__|$REPO_ROOT|" "$HERE/Info.plist" > "$APP/Contents/Info.plist"
# A bundle that can't find the daemon starts, logs, and serves nothing — so this
# is checked here rather than discovered as an empty Spotlight.
grep -q "__REPO_ROOT__" "$APP/Contents/Info.plist" && { echo "!! repo root not substituted"; exit 1; }
[ -f "$REPO_ROOT/packages/daemon/src/index.ts" ] || { echo "!! no daemon at $REPO_ROOT"; exit 1; }

echo "==> Bundling the daemon"
# Into Application Support, next to the app — deliberately not left in the repo.
#
# A LaunchAgent cannot read ~/Documents: it is TCC-protected, and a background
# job has no way to ask for the permission and no window to ask in. It can stat
# the path and gets "Operation not permitted" on everything inside, so an app
# launched by launchd could not read the daemon it was supposed to run, and did
# not survive finding that out. Bundling removes the question: one file, no
# node_modules, nothing under ~/Documents touched after install.
#
# ESM with a require shim: the tree still contains a dependency that calls
# require, and CJS can't take the daemon's top-level await.
ESBUILD="$(find "$REPO_ROOT/../node_modules/.pnpm" -maxdepth 6 -path '*esbuild@*/bin/esbuild' -type f 2>/dev/null | sort | tail -1)"
[ -x "$ESBUILD" ] || { echo "!! no esbuild found under node_modules/.pnpm"; exit 1; }
"$ESBUILD" "$HERE/../packages/daemon/src/index.ts" \
  --bundle --platform=node --format=esm --target=node22 --log-level=warning \
  --banner:js="import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" \
  --outfile="$(dirname "$APP")/daemon.mjs"

echo "==> Icon"
# Needs Pillow. A build-time dependency on this machine only — nothing the
# daemon or the app depends on at runtime.
mkdir -p "$APP/Contents/Resources"
python3 "$HERE/make-icon.py" "$REPO_ROOT/../assets/HermesLogo.png" "$APP/Contents/Resources"
rm -rf "$APP/Contents/Resources/Talaria.iconset"

if [ -d "$HERE/Talaria.icon" ]; then
  # The modern path. macOS 26 treats a bare .icns or a hand-built asset catalog
  # as legacy and wraps it — shrinking the artwork and drawing it inside a
  # container of its own, which is the frame that then badges every Spotlight
  # result. An Icon Composer document is what it renders natively.
  #
  # Note the .icon goes to actool DIRECTLY. Putting it inside an .xcassets, the
  # way an image set would go, compiles silently to nothing at all.
  echo "    (Icon Composer document)"
  rm -rf "$APP/Contents/Resources/Talaria.xcassets"
  xcrun actool "$HERE/Talaria.icon" \
    --compile "$APP/Contents/Resources" \
    --platform macosx \
    --minimum-deployment-target 26.0 \
    --app-icon Talaria \
    --output-partial-info-plist "$APP/Contents/Resources/.actool.plist" >/dev/null
  ICON_NAME="Talaria"
else
  # Fallback for a checkout without the .icon document: the generated asset
  # catalog. Correct, and still wrapped by macOS 26.
  echo "    (generated asset catalog — no Talaria.icon present)"
  xcrun actool "$APP/Contents/Resources/Talaria.xcassets" \
    --compile "$APP/Contents/Resources" \
    --platform macosx \
    --minimum-deployment-target 14.0 \
    --app-icon AppIcon \
    --output-partial-info-plist "$APP/Contents/Resources/.actool.plist" >/dev/null
  ICON_NAME="AppIcon"
fi
rm -rf "$APP/Contents/Resources/Talaria.xcassets" "$APP/Contents/Resources/.actool.plist"
# Whichever path ran, the plist has to name what it produced.
plutil -replace CFBundleIconName -string "$ICON_NAME" "$APP/Contents/Info.plist"
plutil -replace CFBundleIconFile -string "$ICON_NAME" "$APP/Contents/Info.plist"

echo "==> Compiling"
xcrun swiftc \
  -O \
  -target arm64-apple-macos14.0 \
  -framework AppKit -framework WebKit -framework CoreSpotlight -framework UniformTypeIdentifiers -framework ApplicationServices \
  -o "$APP/Contents/MacOS/Talaria" \
  "$HERE/Sources/Daemon.swift" "$HERE/Sources/Indexer.swift" "$HERE/Sources/Theme.swift" "$HERE/Sources/HermesWindow.swift" "$HERE/Sources/Hotkey.swift" "$HERE/Sources/MirrorWatch.swift" "$HERE/Sources/BoardView.swift" "$HERE/Sources/AgendaView.swift" "$HERE/Sources/GlanceView.swift" "$HERE/Sources/AssistantView.swift" "$HERE/Sources/ComposeView.swift" "$HERE/Sources/Settings.swift" "$HERE/Sources/SettingsView.swift" "$HERE/Sources/main.swift"

# A second, tiny binary rather than a function in the app.
#
# Reading the accessibility tree is the one thing here that needs a permission
# grant, and keeping it in its own process keeps that fact visible: it starts
# when asked, answers, and exits. Nothing observes, which is the distinction the
# design turns on — three apps holding AX observers beachball, a process that
# asks one question does not.
xcrun swiftc \
  -O \
  -target arm64-apple-macos14.0 \
  -framework AppKit -framework ApplicationServices \
  -o "$APP/Contents/MacOS/talaria-ax" \
  "$HERE/ax/main.swift"

# Signed with a real identity when one is available, and this is not cosmetic.
#
# macOS keys an accessibility grant to a program's code signature. An ad-hoc
# signature has no stable identity, so the requirement becomes the *hash* — and
# the hash changes on every build. That is why a grant made on Tuesday stops
# working on Wednesday and the entry sits in the list looking granted: it is,
# but for a program that no longer exists.
#
# A Developer ID identity is stable across rebuilds, so the grant is made once.
# Falls back to ad-hoc when there is no certificate, which still runs and still
# loses its permissions every build — worth saying out loud rather than
# discovering.
#
# The helper is signed first and under the app's own identifier. It is a
# separate program to macOS otherwise, named after its binary by swiftc, and a
# grant on the app never covered it.
SIGN_ID="$(security find-identity -v -p codesigning 2>/dev/null \
  | awk -F'"' '/Developer ID Application/ {print $2; exit}')"
if [ -n "$SIGN_ID" ]; then
  echo "==> Signing as: $SIGN_ID"
else
  echo "==> Signing (ad-hoc — no Developer ID found; permissions will not survive a rebuild)"
  SIGN_ID="-"
fi
codesign --force --sign "$SIGN_ID" --identifier dev.talaria.Talaria \
  --options runtime "$APP/Contents/MacOS/talaria-ax"
# The app, and the one entitlement it needs.
#
# `--options runtime` is not optional here — a Developer ID signature without
# the hardened runtime is not something macOS will let hold a TCC grant for
# long. But the hardened runtime also blocks Apple Events outright unless the
# bundle is entitled to send them, and blocks them *silently*: the send fails
# with errAEEventNotPermitted and no prompt is ever shown, because an
# unentitled process is not allowed to ask. Word therefore looked exactly like
# an application that had refused permission nobody had been offered.
codesign --force --sign "$SIGN_ID" --identifier dev.talaria.Talaria \
  --options runtime --entitlements "$HERE/Talaria.entitlements" "$APP"
codesign --verify --strict "$APP"
# Checked rather than assumed. A signature that silently lost its entitlements
# is the same bug again, and it is invisible until somebody opens Word.
codesign -d --entitlements - --xml "$APP" 2>/dev/null | grep -q 'automation.apple-events' \
  || { echo "!! the bundle is not entitled to send Apple Events — Word will fail silently"; exit 1; }

echo "==> Swapping into place"
rm -rf "$FINAL.previous"
[ -d "$FINAL" ] && mv "$FINAL" "$FINAL.previous"
mv "$APP" "$FINAL"
rm -rf "$FINAL.previous"
APP="$FINAL"

echo "==> Registering with LaunchServices (so talaria:// routes here)"
# Icon services cache by path and modification date, so an app rebuilt in place
# keeps showing the icon it had. Touching it is what makes a new one appear.
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "$APP"

# The pasteboard server caches Service declarations. Without this the menu
# items can take until the next login to appear — and their absence looks
# exactly like a bug in the app.
/System/Library/CoreServices/pbs -flush 2>/dev/null || true

echo "built $APP"
