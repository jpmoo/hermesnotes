#!/usr/bin/env bash
# Decode every payload the app relies on, against the running daemon.
#
# Separate from the app's own build because it is a different program with a
# different entry point, and compiled from the same Daemon.swift so it is
# checking the shapes the app will actually use rather than a copy of them.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SOCK="$HOME/Library/Application Support/Talaria/talaria.sock"
[ -S "$SOCK" ] || { echo "!! no daemon socket at $SOCK — start Talaria first"; exit 1; }
OUT="$(mktemp -d)/paycheck"
xcrun swiftc -O -target arm64-apple-macos14.0 -framework AppKit \
  -o "$OUT" "$HERE/Sources/Daemon.swift" "$HERE/check/main.swift"
exec "$OUT"
