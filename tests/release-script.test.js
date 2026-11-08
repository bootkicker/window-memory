const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'release.sh'), 'utf8');

test('release.sh commits carry only the release message, with no co-author trailer', () => {
    const commits = script.split('\n').filter((line) => /\bgit commit\b/.test(line));
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
