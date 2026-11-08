#!/usr/bin/env bash
# Read-only check of the installed Window Memory copy against the repository, and of what Cinnamon is running.
# Answers the question "is the code I changed really the code that is running?" (see docs/manual-test.md).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
UUID="window-memory@bootkicker"
SRC="$ROOT/files/$UUID"
EXT_ROOT="$HOME/.local/share/cinnamon/extensions"
EXT_DIR="$EXT_ROOT/$UUID"
STATE="$HOME/.config/window-memory/state.json"
LOG="$HOME/.xsession-errors"
warn() { echo "  WARNING: $*"; }

echo "repository HEAD:      $(git -C "$ROOT" rev-parse --short HEAD) $(git -C "$ROOT" log -1 --format=%s | cut -c1-60)"
if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then echo "repository changes:   uncommitted changes exist (the installed copy may not match HEAD)"; fi

if [ -d "$EXT_DIR" ]; then
    # Cinnamon rewrites metadata.json (formatting, a "last-edited" key): compare it as JSON without that key.
    META_SAME="$(python3 -c "import json,sys
a, b = (json.load(open(p)) for p in sys.argv[1:3])
b.pop('last-edited', None)
print('yes' if a == b else 'no')" "$SRC/metadata.json" "$EXT_DIR/metadata.json" 2>/dev/null || echo no)"
    if [ "$META_SAME" = yes ] && diff -rq "$SRC" "$EXT_DIR" -x version.json -x metadata.json -x __pycache__ >/dev/null 2>&1; then
        echo "installed copy:       matches the repository source"
    else
        echo "installed copy:       DIFFERS from the repository source"
        warn "run scripts/dev-reinstall.sh, then disable and enable the extension (Extensions settings, or gsettings), or restart Cinnamon"
    fi
    VER="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['commit'][:7])" "$EXT_DIR/version.json" 2>/dev/null || echo none)"
    echo "installed version:    commit $VER"
else
    echo "installed copy:       not installed in $EXT_DIR"
fi

STALE="$(ls -d "$EXT_ROOT"/window-memory@* 2>/dev/null | grep -v "/$UUID\$" || true)"
[ -z "$STALE" ] || { echo "other copies:         $STALE"; warn "old copies can keep running; remove them and restart Cinnamon"; }

ENABLED="$(gsettings get org.cinnamon enabled-extensions 2>/dev/null || echo unknown)"
echo "enabled list:         $ENABLED"
if echo "$ENABLED" | grep -q "window-memory@"; then
    echo "$ENABLED" | grep -o "window-memory@[A-Za-z0-9._-]*" | grep -v "^$UUID\$" | sed 's/^/  WARNING: stale UUID enabled: /' || true
fi
echo "Cinnamon started:     $(ps -o lstart= -C cinnamon 2>/dev/null | head -1 | sed 's/^ *//' || echo unknown)"
LOADS="$(grep "Loaded extension $UUID" "$LOG" 2>/dev/null | tail -n 1 | cut -c1-120 || true)"
echo "last load in log:     ${LOADS:-none since the log started}"

if [ -f "$STATE" ]; then
    AGE=$(( $(date +%s) - $(stat -c %Y "$STATE") ))
    echo "state.json changed:   ${AGE}s ago"
    if [ "$AGE" -lt 120 ] && ! echo "$ENABLED" | grep -q "$UUID"; then
        warn "the state file changed recently but the extension is not enabled: an old copy may still be running; restart Cinnamon"
    fi
else
    echo "state.json:           none yet"
fi
