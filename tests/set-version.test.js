const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const setVersion = path.join(root, 'scripts', 'set-version.js');
const UUID = 'window-memory@bootkicker';

// A copy of the two version files in a temporary folder laid out like the repository.
function tempRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-set-version-'));
    fs.mkdirSync(path.join(dir, 'files', UUID), { recursive: true });
    fs.copyFileSync(path.join(root, 'package.json'), path.join(dir, 'package.json'));
    fs.copyFileSync(path.join(root, 'files', UUID, 'metadata.json'), path.join(dir, 'files', UUID, 'metadata.json'));
    return dir;
}

function run(args) {
    return spawnSync(process.execPath, [setVersion, ...args], { encoding: 'utf8' });
}

test('set-version.js writes the version into metadata.json and package.json and keeps the other keys', () => {
    const dir = tempRepo();
    try {
        const before = JSON.parse(fs.readFileSync(path.join(dir, 'files', UUID, 'metadata.json'), 'utf8'));
        const pkgBefore = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        const r = run(['9.8.7', '--root', dir]);
        assert.equal(r.status, 0, r.stderr);
        const metaText = fs.readFileSync(path.join(dir, 'files', UUID, 'metadata.json'), 'utf8');
        const pkgText = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
        const meta = JSON.parse(metaText);
        const pkg = JSON.parse(pkgText);
        assert.equal(meta.version, '9.8.7');
        assert.equal(pkg.version, '9.8.7');
        assert.deepEqual({ ...meta, version: before.version }, before, 'metadata keeps its other keys');
        assert.deepEqual({ ...pkg, version: pkgBefore.version }, pkgBefore, 'package.json keeps its other keys');
        assert.deepEqual(Object.keys(meta), Object.keys(before), 'metadata keeps its key order');
        assert.equal(metaText, JSON.stringify(meta, null, 4) + '\n', 'metadata stays indented by 4 with a final newline');
        assert.equal(pkgText, JSON.stringify(pkg) + '\n', 'package.json stays on one line with a final newline');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('set-version.js refuses a version that is not X.Y.Z and changes nothing', () => {
    const dir = tempRepo();
    try {
        const metaPath = path.join(dir, 'files', UUID, 'metadata.json');
        const metaBefore = fs.readFileSync(metaPath, 'utf8');
        const pkgBefore = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
        for (const bad of ['1.2', 'v1.2.3', '1.2.3-beta', '']) {
            const r = run([bad, '--root', dir]);
            assert.notEqual(r.status, 0, `"${bad}" must be refused`);
        }
        assert.equal(fs.readFileSync(metaPath, 'utf8'), metaBefore);
        assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), pkgBefore);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('release.sh bumps the version with set-version.js and commits both files, so the release commit keeps the tests green', () => {
    const script = fs.readFileSync(path.join(root, 'scripts', 'release.sh'), 'utf8');
    assert.match(script, /node scripts\/set-version\.js "\$VERSION"/);
    assert.match(script, /git add "files\/\$UUID\/metadata\.json" package\.json/);
});
