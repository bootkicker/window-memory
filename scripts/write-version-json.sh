#!/usr/bin/env bash
# Writes version.json into the extension folder given as the only argument:
#   {"commit": "<full hash>", "short": "<its first 7 characters>", "dirty": true|false}
# commit is the last commit that changed the extension's own folder (files/<name>), so commits that only
# touch docs or tests do not change the version shown. HEAD is used only when that folder has no commit yet.
# dirty is true when `git status --porcelain -- files` lists anything (changes, or files git does not track yet).
# The Version row of the settings window (version_info.py) reads it. The file belongs to the installed
# copy and the package only: .gitignore keeps it out of the repository.
# Used by dev-reinstall.sh (installed copy) and package.sh (dist/). The uuid comes from the folder's metadata.json.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ "$#" -eq 1 ] && [ -d "$1" ] || { echo "usage: $0 <extension folder>" >&2; exit 1; }
uuid="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1] + '/metadata.json'))['uuid'])" "$1" 2>/dev/null || true)"
[ -n "$uuid" ] || { echo "write-version-json: $1/metadata.json has no uuid; not writing version.json" >&2; exit 1; }
commit="$(git -C "$ROOT" log -1 --format=%H -- "files/$uuid")"
[ -n "$commit" ] || commit="$(git -C "$ROOT" rev-parse HEAD)"
if [ -n "$(git -C "$ROOT" status --porcelain -- files)" ]; then dirty=true; else dirty=false; fi
printf '{"commit": "%s", "short": "%s", "dirty": %s}\n' "$commit" "${commit:0:7}" "$dirty" > "$1/version.json"
