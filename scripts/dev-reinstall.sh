#!/usr/bin/env bash
# Removes the installed Window Memory copy and installs the current source.
# Afterwards Cinnamon must load the new copy: disable and enable the extension (Extensions settings, or
# gsettings), or restart Cinnamon.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UUID="window-memory@bootkicker"
SRC="$ROOT/files/$UUID"
DEST="$HOME/.local/share/cinnamon/extensions/$UUID"
[ -d "$SRC" ] || { echo "missing source: $SRC" >&2; exit 1; }
if [ -n "$(git -C "$ROOT" status --porcelain -- files)" ]; then
    echo "warning: uncommitted changes under files/ will be installed" >&2
fi
rm -rf -- "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -r "$SRC" "$DEST"
diff -rq "$SRC" "$DEST"
# After the diff, which would report the new file as extra. The Version row of the settings window shows it.
"$ROOT/scripts/write-version-json.sh" "$DEST"
# The translations, compiled as the Spices installer compiles them (cinnamon-settings bin/Spices.py:733-737): each
# po/<lang>.po into ~/.local/share/locale/<lang>/LC_MESSAGES/<uuid>.mo, where the extension and its settings window look
# for them. Nothing else in that folder is touched. A file that msgfmt -c refuses stops the script.
LOCALE="$HOME/.local/share/locale"
POS=("$SRC"/po/*.po)
if [ -e "${POS[0]}" ]; then
    if command -v msgfmt >/dev/null; then
        for po in "${POS[@]}"; do
            name="$(basename "$po")"
            lang="${name%%.*}"
            mkdir -p "$LOCALE/$lang/LC_MESSAGES"
            msgfmt -c -o "$LOCALE/$lang/LC_MESSAGES/$UUID.mo" "$po"
        done
        echo "compiled ${#POS[@]} translations into $LOCALE"
    else
        echo "warning: msgfmt is not installed (package gettext); the translations were not compiled" >&2
    fi
fi
echo "installed $UUID; the settings window will show commit $(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['short'])" "$DEST/version.json" 2>/dev/null || echo unknown) (repository HEAD is $(git -C "$ROOT" rev-parse --short HEAD))"
echo "To load it, disable and enable the extension (Extensions settings, or gsettings), or restart Cinnamon."
