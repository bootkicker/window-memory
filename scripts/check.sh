#!/usr/bin/env bash
# Quick checks before a commit or a release: tests, Python and shell syntax, translation template, git state.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$ROOT"
FAILED=0
fail() { echo "  FAIL: $*"; FAILED=1; }

echo "== tests"
LOG="$(mktemp)"
if node --test >"$LOG" 2>&1; then grep -E "^ℹ (tests|pass|fail)" "$LOG"; else grep -E "^ℹ (tests|pass|fail)|^✖" "$LOG" | head -n 20; fail "node --test"; fi
rm -f "$LOG"

echo "== python syntax"
while IFS= read -r f; do
    python3 -c "import ast,sys; ast.parse(open(sys.argv[1], encoding='utf-8').read(), sys.argv[1])" "$f" 2>/dev/null || fail "$f does not parse"
done < <(git ls-files 'files/*.py' 'tests/*.py' 'tests/helpers/*.py' 'scripts/*.py')
echo "  done"

echo "== shell syntax"
for f in scripts/*.sh; do bash -n "$f" || fail "$f"; done
echo "  done"

echo "== translation template"
if ! node scripts/make-pot.js; then fail "make-pot.js failed: the template was not checked"
elif git diff --quiet -- files/window-memory@bootkicker/po; then echo "  up to date"; else fail "the translation template changed: commit it (git diff files/window-memory@bootkicker/po)"; fi

echo "== git"
if [ -z "$(git status --porcelain)" ]; then echo "  clean"; else git status --short; echo "  (uncommitted changes above)"; fi

if [ "$FAILED" = 0 ]; then echo "ALL CHECKS PASSED"; else echo "SOME CHECKS FAILED"; exit 1; fi
