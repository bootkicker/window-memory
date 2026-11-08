// SPDX-License-Identifier: GPL-3.0-or-later
// The "Back up or restore" row of the settings window (files/window-memory@bootkicker/backup_buttons.py).
// The file checks run anywhere. The function checks need python3 and nothing else. The widget
// checks need python3 with GTK 3, xapp and a display; they skip themselves without them. Neither
// touches the real configuration folder or talks to the real Cinnamon: see the harness.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const extDir = path.join(__dirname, '..', 'files', 'window-memory@bootkicker');
const file = path.join(extDir, 'backup_buttons.py');
const harness = path.join(__dirname, 'helpers', 'backup_harness.py');
const SKIP_EXIT = 77;
const hasPython = !spawnSync('python3', ['--version']).error;
// An unreachable session bus: even a bug cannot call the real Cinnamon.
const NO_BUS = Object.assign({}, process.env, { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent' });

test('backup_buttons.py starts with the SPDX line and names the uuid of the extension', () => {
    const src = fs.readFileSync(file, 'utf8');
    assert.equal(src.split('\n')[0], '# SPDX-License-Identifier: GPL-3.0-or-later');
    const meta = JSON.parse(fs.readFileSync(path.join(extDir, 'metadata.json'), 'utf8'));
    assert.equal(/^UUID = '([^']+)'$/m.exec(src)[1], meta.uuid);
});

// The page and the extension meet only through these names, so a rename on one side alone would break the restore
// unnoticed: the callback the page calls, and the staging file it writes for the extension to read. Read as text.
test('the page calls a callback that callbacks() in extension.js has, and writes the staging file that extension.js reads', () => {
    const page = fs.readFileSync(file, 'utf8');
    const ext = fs.readFileSync(path.join(extDir, 'extension.js'), 'utf8');
    const callback = /^IMPORT_CALLBACK = '([^']+)'$/m.exec(page);
    assert.ok(callback, 'IMPORT_CALLBACK in backup_buttons.py');
    assert.equal(callback[1], 'importState');
    const callbacks = /^ {4}callbacks\(\) \{\s*return \{([^}]*)\}/m.exec(ext);
    assert.ok(callbacks, 'callbacks() in extension.js');
    assert.match(callbacks[1], /^\s*importState:/m);
    const name = /^STAGING_NAME = '([^']+)'$/m.exec(page);
    assert.ok(name, 'STAGING_NAME in backup_buttons.py');
    assert.match(page, /os\.path\.join\(config_dir, 'window-memory', STAGING_NAME\)/, 'staging_path uses STAGING_NAME');
    const stagingPath = /^const STAGING_PATH = STATE_DIR \+ '([^']+)';$/m.exec(ext);
    assert.ok(stagingPath, 'STAGING_PATH in extension.js');
    assert.equal(name[1], path.posix.basename(stagingPath[1]));
});

test('backup_buttons.py is valid Python 3', (t) => {
    if (!hasPython) return t.skip('python3 is not installed');
    // The compiled file goes to a temp dir, so no __pycache__ appears in the extension folder.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-buttons-'));
    try {
        const r = spawnSync('python3', ['-B', '-c',
            'import py_compile, sys; py_compile.compile(sys.argv[1], cfile=sys.argv[2], doraise=True)',
            file, path.join(tmp, 'backup_buttons.pyc')], { encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('the plain functions build a backup that passes the check, refuse every bad backup with its own message without blocking on a FIFO, write files atomically with mode 0600 and stage the windows under XDG_CONFIG_HOME, with the Python standard library only', (t) => {
    if (!hasPython) return t.skip('python3 is not installed');
    // -I -S: no site packages and no PYTHONPATH, so only the standard library can be imported.
    const r = spawnSync('python3', ['-B', '-I', '-S', harness, extDir, 'functions'], { encoding: 'utf8', env: NO_BUS });
    assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('the widget shows the two buttons of the schema, exports a backup, and on import stages the windows, sets a larger max-entries before importState and the other settings only after it succeeded; a failed call sets max-entries back, an unanswered one keeps it and says so', (t) => {
    if (!hasPython) return t.skip('python3 is not installed');
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return t.skip('no display');
    const r = spawnSync('python3', ['-B', harness, extDir, 'widget'], { encoding: 'utf8', env: NO_BUS });
    if (r.status === SKIP_EXIT) return t.skip(r.stdout.trim());
    assert.equal(r.status, 0, r.stdout + r.stderr);
});
