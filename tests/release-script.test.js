const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'release.sh'), 'utf8');

test('release.sh commits carry only the release message, with no co-author trailer', () => {
    const commits = script.split('\n').filter((line) => /^\s*git\b.*\bcommit -q\b/.test(line));
    assert.ok(commits.length >= 2, 'the release commit and the store folder commit are found');
    for (const line of commits) assert.doesNotMatch(line, /Co-Authored-By/i, line.trim());
    assert.doesNotMatch(script, /noreply@anthropic\.com/);
});

test('release.sh writes no generator footer into the store pull request', () => {
    assert.doesNotMatch(script, /Generated with/i);
    assert.doesNotMatch(script, /claude\.com/i);
});

test('release.sh refuses --submit unless the repository is public, with no private-phase story', () => {
    assert.match(script, /gh repo view bootkicker\/window-memory --json visibility/);
    assert.match(script, /"\$VIS" != PUBLIC/);
    assert.doesNotMatch(script, /reviewers cannot open/);
});

// linuxmint/cinnamon-spices-extensions CONTRIBUTING.md: commit messages and pull request titles are
// "spice name: simple description"; others are closed.
test('release.sh names the store commit and pull request "uuid: description", a new extension apart from an update', () => {
    assert.match(script, /git ls-tree --name-only origin\/HEAD -- "\$UUID"/, 'the store folder is looked up at origin/HEAD');
    assert.match(script, /BRANCH_STORE="add-\$UUID"/);
    assert.match(script, /TITLE="\$UUID: Add new extension"/);
    assert.match(script, /BRANCH_STORE="update-\$UUID-\$VERSION"/);
    assert.match(script, /TITLE="\$UUID: Update to \$VERSION"/);
    assert.match(script, /\bcommit -q -m "\$TITLE"/);
    assert.match(script, /--title "\$TITLE"/);
    assert.ok(script.indexOf('git ls-tree') < script.indexOf('git checkout -q -B "$BRANCH_STORE" origin/HEAD'),
        'the branch is chosen before it is checked out');
});

// The lines between the two markers write the pull request body; they are run here with stand-in values.
function writeBody(t, readme) {
    const { execFileSync } = require('node:child_process');
    const os = require('node:os');
    const start = script.indexOf('# >>> pull request body');
    const end = script.indexOf('# <<< pull request body');
    assert.ok(start > 0 && end > start, 'the body markers are found');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-release-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    fs.writeFileSync(path.join(tmp, 'README.md'), readme);
    const prelude = 'set -euo pipefail\ndie() { echo "release: $*" >&2; exit 1; }\n'
        + `ROOT=${JSON.stringify(tmp)}; UUID=window-memory@bootkicker; VERSION=1.2.3; SOURCE_COMMIT=0123abc; BODY="$ROOT/body.md"\n`;
    execFileSync('bash', ['-c', prelude + script.slice(start, end)], { stdio: ['ignore', 'pipe', 'pipe'] });
    return fs.readFileSync(path.join(tmp, 'body.md'), 'utf8');
}

test('the store pull request body says what the extension does, why the Startup apps tab belongs, where it was tested, and answers the scanner', (t) => {
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    const body = writeBody(t, readme);
    assert.match(body, /remembers where each window was/);
    for (const feature of ['size, position, monitor, workspace, maximized and minimized state', 'never-remember list',
        'Startup apps', 'Back up', '24 languages']) assert.ok(body.includes(feature), feature);
    assert.match(body, /~\/\.config\/autostart/);
    assert.match(body, /Startup Applications tool/);
    assert.match(body, /Linux Mint 21\.3/);
    assert.match(body, /Cinnamon 6\.0\.5/);
    assert.match(body, /X11/);
    assert.match(body, /Wayland/);
    assert.match(body, /Notes for reviewers/);
    assert.match(body, /set_stage_input_mode/);
    assert.match(body, /Cinnamon 6\.8's native importer \(`getCurrentExtension\(\)\.imports`\)/);
    assert.match(body, /`require\(\)` only on Cinnamon 6\.0 to 6\.6, which have no `getCurrentExtension\(\)`/);
    assert.match(body, /no file uses `module\.exports`/);
    assert.doesNotMatch(body, /guarded|is planned/, 'the old note about the guarded module.exports is gone');
    assert.match(body, /synchronously/);
    assert.match(body, /written synchronously/, 'the state writes are answered too, not only the reads');
    assert.ok(body.includes('https://github.com/bootkicker/window-memory/commit/0123abc'), 'the source commit link');
    assert.doesNotMatch(body, /Claude|Anthropic|\bAI\b|agent|Generated with/i);
});

test('the pull request body takes the tested versions from README.md and stops when that line is missing', (t) => {
    const body = writeBody(t, '# Window Memory\n\nRequirements: Cinnamon 9.9. Tested on Some Distro 1.0 with Cinnamon 9.9.1.\n');
    assert.match(body, /Tested on Some Distro 1\.0 with Cinnamon 9\.9\.1\./);
    assert.throws(() => writeBody(t, '# Window Memory\n'), /Tested on/);
});

test('release.sh makes the store commit with the identity of the repository it releases from, not the global git name', () => {
    const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'release.sh'), 'utf8');
    assert.match(script, /git -C "\$ROOT" config --local user\.name \|\| true/, 'the repository identity only, never the global one');
    assert.match(script, /git -C "\$ROOT" config --local user\.email \|\| true/);
    assert.match(script, /git -C \\"\$ROOT\\" config --local user\.name NAME; git -C \\"\$ROOT\\" config --local user\.email EMAIL/,
        'the message shows commands that set the identity in that repository only');
    assert.match(script, /git -c user\.name="\$STORE_NAME" -c user\.email="\$STORE_EMAIL" commit -q -m "\$TITLE"/);
    assert.doesNotMatch(script, /^git commit -q -m "\$TITLE"$/m, 'a plain commit would take the global git name');
});

// A second run for the same submission (a fix while the first pull request is still open) must not call gh pr create, which
// fails for a branch that already has an open pull request: it updates that pull request's body instead.
test('release.sh updates the body of an open pull request from the same store branch instead of opening a second one', () => {
    const submit = script.slice(script.indexOf('say "submitting"'));
    assert.match(submit, /gh pr list --repo "\$SPICES_REPO" --head "\$BRANCH_STORE" --state open/);
    assert.match(submit, /select\(\.headRepositoryOwner\.login == "bootkicker"\)/, 'only a pull request from our fork counts');
    assert.match(submit, /gh pr edit "\$EXISTING_PR" --repo "\$SPICES_REPO" --body-file "\$BODY"/);
    assert.match(submit, /gh pr create --repo "\$SPICES_REPO" --head "bootkicker:\$BRANCH_STORE"/);
    const edit = submit.indexOf('gh pr edit'), create = submit.indexOf('gh pr create');
    const check = submit.indexOf('if [ -n "$EXISTING_PR" ]');
    assert.ok(check > 0 && check < edit && edit < create, 'the edit is the branch taken when a pull request exists');
    assert.match(submit, /echo "  updated the body of the open pull request #\$EXISTING_PR"/);
    assert.match(submit, /echo "  opened a new pull request"/);
    assert.ok(submit.indexOf('git push -q -f fork "$BRANCH_STORE"') < check, 'the branch is pushed first, so an open pull request shows the new commit');
});
