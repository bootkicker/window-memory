#!/usr/bin/env bash
# Prepares a release of Window Memory for the Cinnamon Spices store. One command:
#   scripts/release.sh <version>            prepare everything locally and show what would be submitted
#   scripts/release.sh <version> --submit   also push the release to GitHub and open the store pull request
#
# Steps: check the repository is clean, pushed and tested; check the version is new, CHANGELOG.md has it and
# screenshot.png exists; bump metadata.json and package.json (set-version.js); commit; tag vX.Y.Z;
# build dist/ (package.sh writes version.json with the commit that last changed the extension); put the folder
# on a branch of your fork of linuxmint/cinnamon-spices-extensions; run validate-spice.
# Nothing is pushed or opened without --submit.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
UUID="window-memory@bootkicker"
EXT="$ROOT/files/$UUID"
SPICES_UPSTREAM="${SPICES_UPSTREAM:-https://github.com/linuxmint/cinnamon-spices-extensions}"
SPICES_FORK="${SPICES_FORK:-https://github.com/bootkicker/cinnamon-spices-extensions}"
SPICES_REPO="${SPICES_REPO:-linuxmint/cinnamon-spices-extensions}"
WORK="${RELEASE_WORK:-$HOME/.cache/window-memory-release}"

die() { echo "release: $*" >&2; exit 1; }
say() { echo "== $*"; }

VERSION="${1:-}"; shift || true
SUBMIT=0
for arg in "$@"; do
    case "$arg" in
        --submit) SUBMIT=1 ;;
        *) die "unknown option: $arg" ;;
    esac
done
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "usage: $0 <X.Y.Z> [--submit]  (got '$VERSION')"

cd "$ROOT"
BRANCH="$(git branch --show-current)"
[ -n "$BRANCH" ] || die "not on a branch"

say "checking the repository"
[ -z "$(git status --porcelain)" ] || die "uncommitted or untracked changes; commit or stash them first"
git rev-parse --verify --quiet "@{u}" >/dev/null || die "branch $BRANCH has no upstream; push it first"
UNPUSHED="$(git rev-list --count '@{u}..HEAD')"
if [ "$UNPUSHED" != 0 ]; then
    { [ "$UNPUSHED" = 1 ] && [ "$(git log -1 --format=%s)" = "release: $VERSION" ]; } \
        || die "local commits are not pushed yet; push $BRANCH first"
fi

say "running the tests"
node --test >/dev/null 2>&1 || die "tests fail; run node --test"
# The tests and package.sh regenerate the translation template. A stale one would change the tree after the tag
# and make the package say "uncommitted changes", so it must be committed before the release.
node scripts/make-pot.js || die "make-pot.js failed"
[ -z "$(git status --porcelain)" ] || die "the tests or make-pot.js changed files (the translation template is out of date?); commit them first: git status"

say "checking the version and store files"
CURRENT="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['version'])" "$EXT/metadata.json")"
LAST="$(git tag -l 'v*' --sort=-v:refname | grep -vx "v$VERSION" | head -1 | sed 's/^v//' || true)"
if [ -n "$LAST" ]; then
    python3 -c "import sys; a=tuple(map(int,sys.argv[1].split('.'))); b=tuple(map(int,sys.argv[2].split('.'))); sys.exit(0 if a>b else 1)" "$VERSION" "$LAST" \
        || die "$VERSION is not newer than the last release $LAST"
else
    python3 -c "import sys; a=tuple(map(int,sys.argv[1].split('.'))); b=tuple(map(int,sys.argv[2].split('.'))); sys.exit(0 if a>=b else 1)" "$VERSION" "$CURRENT" \
        || die "$VERSION is older than the version in metadata.json ($CURRENT)"
fi
grep -q "^## $VERSION\$" CHANGELOG.md || die "CHANGELOG.md has no section '## $VERSION'; write the release notes first"
[ -f screenshot.png ] || die "screenshot.png is missing in the repository root; the store listing needs it"

VIS="$(gh repo view bootkicker/window-memory --json visibility -q .visibility 2>/dev/null || echo UNKNOWN)"
if [ "$VIS" != PUBLIC ]; then
    echo "note: bootkicker/window-memory is $VIS, not PUBLIC; --submit needs it public"
    [ "$SUBMIT" = 0 ] || die "the repository must be public before submitting; the store reviewers open the commit link"
fi

say "preparing release $VERSION"
if [ "$VERSION" != "$CURRENT" ]; then
    node scripts/set-version.js "$VERSION"
    git add "files/$UUID/metadata.json" package.json
    git commit -q -m "release: $VERSION"
fi
if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then
    [ "$(git rev-parse "v$VERSION^{commit}")" = "$(git rev-parse HEAD)" ] || die "tag v$VERSION exists but is not on HEAD"
else
    git tag -a "v$VERSION" -m "Window Memory $VERSION"
fi
RELEASE_COMMIT="$(git rev-parse HEAD)"
say "tagged v$VERSION on $(git rev-parse --short HEAD)"

say "building the package"
bash scripts/package.sh
DIST="$ROOT/dist/$UUID"
for f in info.json README.md CHANGELOG.md screenshot.png docs/images/settings-restore-apps-at-login.png "files/$UUID/version.json" "files/$UUID/metadata.json" "files/$UUID/extension.js"; do
    [ -f "$DIST/$f" ] || die "package is missing $f"
done
HASH="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['short'])" "$DIST/files/$UUID/version.json")"
grep -q "\"version\": \"$VERSION\"" "$DIST/files/$UUID/metadata.json" || die "package has the wrong version"

say "preparing the store folder in $WORK"
mkdir -p "$WORK"
if [ ! -d "$WORK/spices/.git" ]; then
    git clone -q "$SPICES_UPSTREAM" "$WORK/spices"
fi
cd "$WORK/spices"
gh repo fork "$SPICES_REPO" --clone=false >/dev/null 2>&1 || true   # idempotent: creates your fork once
gh repo view "${SPICES_FORK#https://github.com/}" >/dev/null 2>&1 || die "no fork at $SPICES_FORK (gh repo fork failed)"
git remote get-url fork >/dev/null 2>&1 || git remote add fork "$SPICES_FORK"
git fetch -q origin
BRANCH_STORE="update-$UUID-$VERSION"
git checkout -q -B "$BRANCH_STORE" origin/HEAD
rm -rf "$UUID"
cp -r "$DIST" "$UUID"
if [ -x ./validate-spice ]; then
    ./validate-spice "$UUID" || die "validate-spice reports problems (see above)"
else
    die "validate-spice is missing in the store clone"
fi
git add "$UUID"
git commit -q -m "$UUID $VERSION (commit $HASH)"
STORE_COMMIT="$(git rev-parse --short HEAD)"

BODY="$WORK/pr-body.md"
cat > "$BODY" <<BODY_EOF
Release $VERSION of $UUID.

- Source commit (the code shipped): https://github.com/bootkicker/window-memory/commit/$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['commit'])" "$DIST/files/$UUID/version.json")
- Release tag: v$VERSION in bootkicker/window-memory
- Validated with validate-spice.
BODY_EOF

say "ready"
echo "  store branch:  $BRANCH_STORE (commit $STORE_COMMIT in $WORK/spices)"
echo "  our release:   tag v$VERSION on commit $(git -C "$ROOT" rev-parse --short "$RELEASE_COMMIT")"
echo "  shown in settings: $HASH"
echo "  PR body:       $BODY"
if [ "$SUBMIT" = 0 ]; then
    echo
    echo "Nothing has been pushed or opened. To publish, run again with --submit:"
    echo "  $0 $VERSION --submit"
    exit 0
fi

say "submitting"
git -C "$ROOT" push -q origin "$BRANCH" "v$VERSION"
git push -q -f fork "$BRANCH_STORE"
gh pr create --repo "$SPICES_REPO" --head "bootkicker:$BRANCH_STORE" \
    --title "$UUID $VERSION" --body-file "$BODY"
