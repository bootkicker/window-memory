#!/usr/bin/env bash
# Builds dist/window-memory@bootkicker/ in the Cinnamon Spices layout.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UUID="window-memory@bootkicker"
OUT="$ROOT/dist/$UUID"

node "$ROOT/scripts/make-pot.js"
(cd "$ROOT" && node --test)

rm -rf "$OUT"
mkdir -p "$OUT/files/$UUID"
cp -r "$ROOT/files/$UUID/." "$OUT/files/$UUID/"
# The Version row of the settings window shows the commit this package was built from.
"$ROOT/scripts/write-version-json.sh" "$OUT/files/$UUID"
cp "$ROOT/info.json" "$ROOT/README.md" "$ROOT/CHANGELOG.md" "$OUT/"

if [ ! -f "$ROOT/screenshot.png" ]; then
    echo "screenshot.png is missing: the store listing needs it." >&2
    exit 1
fi
cp "$ROOT/screenshot.png" "$OUT/"
# The README shows a second screenshot from docs/images; the store page needs it next to the README.
mkdir -p "$OUT/docs/images"
cp "$ROOT/docs/images/settings-restore-apps-at-login.png" "$OUT/docs/images/"
echo "Built $OUT"
