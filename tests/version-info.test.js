// SPDX-License-Identifier: GPL-3.0-or-later
// The "Version" row, the last row of the settings window (files/window-memory@bootkicker/version_info.py)
// and the version.json that scripts/write-version-json.sh puts into the installed copy and the package.
// The file checks and the script checks run anywhere with git and bash. The widget test needs python3
// with GTK 3 and a display; it skips itself without them. It never starts a browser: see the harness.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const UUID = 'window-memory@bootkicker';
const extDir = path.join(root, 'files', UUID);
const file = path.join(extDir, 'version_info.py');
const harness = path.join(__dirname, 'helpers', 'version_info_harness.py');
const writer = path.join(root, 'scripts', 'write-version-json.sh');
const SKIP_EXIT = 77;
const hasPython = !spawnSync('python3', ['--version']).error;
const hasGit = !spawnSync('git', ['--version']).error;

function git(args, cwd, home) {
    // Hooks, signing and the user's git configuration never apply: HOME is a temp folder.
    return spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], {
        cwd, encoding: 'utf8', env: Object.assign({}, process.env, { HOME: home, GIT_CONFIG_NOSYSTEM: '1' }),
    });
}

function tmpDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('version_info.py starts with the SPDX line and is valid Python 3', (t) => {
    const src = fs.readFileSync(file, 'utf8');
    assert.equal(src.split('\n')[0], '# SPDX-License-Identifier: GPL-3.0-or-later');
    if (!hasPython) return t.skip('python3 is not installed');
    // The compiled file goes to a temp dir, so no __pycache__ appears in the extension folder.
    const tmp = tmpDir('version-info-');
    try {
        const r = spawnSync('python3', ['-B', '-c',
            'import py_compile, sys; py_compile.compile(sys.argv[1], cfile=sys.argv[2], doraise=True)',
            file, path.join(tmp, 'version_info.pyc')], { encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('version_info.py opens no network connection and starts no process of its own', () => {
    // The link is opened by GTK when the user clicks it (Gtk.LinkButton's default handler).
    // Comments may name these things; the code may not use them.
    const src = fs.readFileSync(file, 'utf8').split('\n').filter(line => !line.trim().startsWith('#')).join('\n');
    for (const word of ['socket', 'urllib', 'http.client', 'requests', 'subprocess', 'os.system', 'webbrowser', 'Gio.AppInfo', 'show_uri', 'Soup'])
        assert.ok(!src.includes(word), 'version_info.py mentions ' + word);
    assert.match(src, /Gtk\.LinkButton/);
    assert.doesNotMatch(src, /activate-link/, 'the default handler of the link button must stay');
});

test('version.json is ignored by git and never tracked', (t) => {
    const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n');
    assert.ok(ignore.includes('files/' + UUID + '/version.json'), '.gitignore lists the version.json of the extension folder');
    if (!hasGit) return t.skip('git is not installed');
    const ignored = spawnSync('git', ['check-ignore', '-q', 'files/' + UUID + '/version.json'], { cwd: root });
    assert.equal(ignored.status, 0, 'git ignores files/' + UUID + '/version.json');
    const tracked = spawnSync('git', ['ls-files', '--', '*version.json'], { cwd: root, encoding: 'utf8' });
    assert.equal(tracked.stdout.trim(), '', 'no version.json is tracked');
});

test('write-version-json.sh writes commit, short and dirty from git; dirty means changes under files/', (t) => {
    if (!hasGit) return t.skip('git is not installed');
    const home = tmpDir('version-json-home-');
    const repo = tmpDir('version-json-repo-');
    try {
        const run = (args, cwd = repo) => {
            const r = git(args, cwd, home);
            assert.equal(r.status, 0, 'git ' + args.join(' ') + ': ' + r.stderr);
            return r.stdout.trim();
        };
        run(['init', '-q']);
        fs.mkdirSync(path.join(repo, 'files', UUID), { recursive: true });
        fs.mkdirSync(path.join(repo, 'scripts'));
        fs.writeFileSync(path.join(repo, 'files', UUID, 'extension.js'), '// one\n');
        fs.writeFileSync(path.join(repo, '.gitignore'), 'files/' + UUID + '/version.json\ndist/\n');
        fs.writeFileSync(path.join(repo, 'README.md'), 'one\n');
        // The script finds the repository from its own location, so the temp repo gets a copy.
        fs.copyFileSync(writer, path.join(repo, 'scripts', 'write-version-json.sh'));
        run(['add', '-A']);
        run(['commit', '-q', '-m', 'first']);
        const target = path.join(repo, 'dist', UUID);
        fs.mkdirSync(target, { recursive: true });
        // The uuid comes from the folder's own metadata.json: without it nothing is written.
        const nothing = path.join(repo, 'dist', 'no-metadata');
        fs.mkdirSync(nothing, { recursive: true });
        const noMeta = spawnSync('bash', [path.join(repo, 'scripts', 'write-version-json.sh'), nothing], { encoding: 'utf8', env: Object.assign({}, process.env, { HOME: home }) });
        assert.equal(noMeta.status, 1, 'a folder without metadata.json is refused');
        assert.ok(!fs.existsSync(path.join(nothing, 'version.json')));
        fs.writeFileSync(path.join(target, 'metadata.json'), JSON.stringify({ uuid: UUID }));
        const write = () => {
            const r = spawnSync('bash', [path.join(repo, 'scripts', 'write-version-json.sh'), target], { encoding: 'utf8', env: Object.assign({}, process.env, { HOME: home }) });
            assert.equal(r.status, 0, r.stderr);
            const text = fs.readFileSync(path.join(target, 'version.json'), 'utf8');
            return { text, data: JSON.parse(text) };
        };

        let { text, data } = write();
        const head = run(['rev-parse', 'HEAD']);
        assert.deepEqual(Object.keys(data), ['commit', 'short', 'dirty']);
        assert.match(data.commit, /^[0-9a-f]{40}$/);
        assert.equal(data.commit, head);
        assert.equal(data.short, head.slice(0, 7));
        assert.equal(data.short.length, 7);
        assert.strictEqual(data.dirty, false, 'a clean tree is not dirty: ' + text);

        // A change outside files/ does not count; version.json itself is ignored and does not count.
        fs.writeFileSync(path.join(repo, 'README.md'), 'two\n');
        assert.strictEqual(write().data.dirty, false, 'a change outside files/ is not dirty');
        fs.writeFileSync(path.join(repo, 'files', UUID, 'version.json'), '{}');
        assert.strictEqual(write().data.dirty, false, 'an ignored version.json is not dirty');
        fs.rmSync(path.join(repo, 'files', UUID, 'version.json'));

        fs.writeFileSync(path.join(repo, 'files', UUID, 'extension.js'), '// two\n');
        assert.strictEqual(write().data.dirty, true, 'a modified file under files/ is dirty');
        run(['checkout', '--', 'files']);
        assert.strictEqual(write().data.dirty, false);
        fs.writeFileSync(path.join(repo, 'files', UUID, 'new.js'), '// new\n');
        assert.strictEqual(write().data.dirty, true, 'an untracked file under files/ is dirty');
        fs.rmSync(path.join(repo, 'files', UUID, 'new.js'));

        // The commit in the file is the last commit that changed the extension folder.
        fs.writeFileSync(path.join(repo, 'files', UUID, 'extension.js'), '// three\n');
        run(['commit', '-q', '-am', 'second']);
        const second = write().data;
        assert.equal(second.commit, run(['rev-parse', 'HEAD']));
        assert.notEqual(second.commit, head);
        assert.strictEqual(second.dirty, false);

        // A commit that only touches docs does not change the version: the folder's commit stays.
        fs.writeFileSync(path.join(repo, 'README.md'), 'three\n');
        run(['commit', '-q', '-am', 'docs only']);
        const docsOnly = write().data;
        assert.notEqual(docsOnly.commit, run(['rev-parse', 'HEAD']), 'HEAD moved but the folder did not');
        assert.equal(docsOnly.commit, second.commit);
        assert.equal(docsOnly.short, second.short);

        // A target that is not a folder is refused and nothing is written.
        const refused = spawnSync('bash', [path.join(repo, 'scripts', 'write-version-json.sh'), path.join(repo, 'missing')], { encoding: 'utf8' });
        assert.notEqual(refused.status, 0);
        assert.ok(!fs.existsSync(path.join(repo, 'missing')));
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(repo, { recursive: true, force: true });
    }
});

test('dev-reinstall.sh puts version.json into the installed copy, not into the repository (run against a temp HOME)', (t) => {
    if (!hasGit) return t.skip('git is not installed');
    const home = tmpDir('dev-reinstall-home-');
    const isChanged = () => spawnSync('git', ['status', '--porcelain', '--', 'files'], { cwd: root, encoding: 'utf8' }).stdout.trim() !== '';
    try {
        const changedBefore = isChanged();
        const r = spawnSync('bash', [path.join(root, 'scripts', 'dev-reinstall.sh')], {
            encoding: 'utf8', env: Object.assign({}, process.env, { HOME: home }),
        });
        assert.equal(r.status, 0, r.stdout + r.stderr);
        const dest = path.join(home, '.local', 'share', 'cinnamon', 'extensions', UUID);
        assert.ok(fs.existsSync(path.join(dest, 'settings-schema.json')), 'the extension was installed under the temp HOME');
        assert.ok(fs.existsSync(path.join(dest, 'version_info.py')), 'version_info.py was installed');

        const written = JSON.parse(fs.readFileSync(path.join(dest, 'version.json'), 'utf8'));
        const head = spawnSync('git', ['log', '-1', '--format=%H', '--', 'files/' + UUID], { cwd: root, encoding: 'utf8' }).stdout.trim();
        const changedAfter = isChanged();  // other test files run at the same time and rewrite the pot
        assert.deepEqual(Object.keys(written), ['commit', 'short', 'dirty']);
        assert.equal(written.commit, head);
        assert.equal(written.short, head.slice(0, 7));
        assert.ok([changedBefore, changedAfter].includes(written.dirty), 'dirty is ' + written.dirty + ' but git said ' + changedBefore + ' before and ' + changedAfter + ' after');

        // The source folder is left alone, and the install is complete apart from the one new file.
        assert.ok(!fs.existsSync(path.join(extDir, 'version.json')), 'the repository has no version.json');
        const same = spawnSync('diff', ['-rq', '-x', 'version.json', '-x', '__pycache__', extDir, dest], { encoding: 'utf8' });
        assert.equal(same.status, 0, same.stdout);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test('package.sh writes version.json into the package folder, after the files are copied', () => {
    const src = fs.readFileSync(path.join(root, 'scripts', 'package.sh'), 'utf8');
    const copy = src.indexOf('cp -r "$ROOT/files/$UUID/." "$OUT/files/$UUID/"');
    const write = src.indexOf('scripts/write-version-json.sh" "$OUT/files/$UUID"');
    assert.ok(copy > 0, 'package.sh copies the extension folder');
    assert.ok(write > copy, 'package.sh writes version.json into dist/ after the copy');
    // dev-reinstall.sh does the same for the installed copy, after its diff check (which would
    // otherwise report the new file as extra).
    const reinstall = fs.readFileSync(path.join(root, 'scripts', 'dev-reinstall.sh'), 'utf8');
    assert.ok(reinstall.indexOf('write-version-json.sh" "$DEST"') > reinstall.indexOf('diff -rq'));
});

test('the widget shows the version, the short hash as a link to the full commit, "(uncommitted changes)", a "Report an issue" link after them (also without version.json), and stays sensitive while "enabled" is off', (t) => {
    if (!hasPython) return t.skip('python3 is not installed');
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return t.skip('no display');
    const r = spawnSync('python3', ['-B', harness, extDir], {
        encoding: 'utf8',
        // An unreachable session bus: even a bug cannot call the real Cinnamon.
        env: Object.assign({}, process.env, { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent' }),
    });
    if (r.status === SKIP_EXIT) return t.skip(r.stdout.trim());
    assert.equal(r.status, 0, r.stdout + r.stderr);
});
