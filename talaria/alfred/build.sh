#!/usr/bin/env bash
# Package the Alfred workflow. An .alfredworkflow is a zip containing info.plist
# (and any icons); double-clicking one imports it.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HERE/Talaria.alfredworkflow}"
TMP="$(mktemp -d)"
cp "$HERE/Talaria.alfredworkflow.plist" "$TMP/info.plist"
# The workflow's icon in Alfred's own list.
[ -f "$HERE/../../assets/HermesLogoSmall.png" ] && cp "$HERE/../../assets/HermesLogoSmall.png" "$TMP/icon.png"
rm -f "$OUT"
(cd "$TMP" && zip -q -r "$OUT" .)
rm -rf "$TMP"
echo "built $OUT"
