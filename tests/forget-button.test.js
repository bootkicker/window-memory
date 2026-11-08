// SPDX-License-Identifier: GPL-3.0-or-later
// The custom settings widget for "forget-all" (files/window-memory@bootkicker/forget_button.py).
// The file checks run anywhere. The widget test needs python3 with GTK 3 and a display; it
// skips itself without them. It never talks to the real Cinnamon, never reads the real
// configuration folder and never shows a dialog: see the harness.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const extDir = path.join(__dirname, '..', 'files', 'window-memory@bootkicker');
const file = path.join(extDir, 'forget_button.py');
const harness = path.join(__dirname, 'helpers', 'forget_button_harness.py');
const SKIP_EXIT = 77;
const hasPython = !spawnSync('python3', ['--version']).error;

test('forget_button.py starts with the SPDX line and names the uuid of the extension', () => {
    const src = fs.readFileSync(file, 'utf8');
    assert.equal(src.split('\n')[0], '# SPDX-License-Identifier: GPL-3.0-or-later');
    const meta = JSON.parse(fs.readFileSync(path.join(extDir, 'metadata.json'), 'utf8'));
    assert.equal(/^UUID = '([^']+)'$/m.exec(src)[1], meta.uuid);
});

test('forget_button.py is valid Python 3', (t) => {
    if (!hasPython) return t.skip('python3 is not installed');
    // The compiled file goes to a temp dir, so no __pycache__ appears in the extension folder.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forget-button-'));
    try {
        const r = spawnSync('python3', ['-B', '-c',
            'import py_compile, sys; py_compile.compile(sys.argv[1], cfile=sys.argv[2], doraise=True)',
            file, path.join(tmp, 'forget_button.pyc')], { encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('the widget builds like cinnamon-settings builds it, shows a red warning icon (or glyph) only while enabled, keeps the label and button colours, has the Pick-a-window border, sends the schema callback, and then says in a dialog how many remembered windows were forgotten, or why they were not', (t) => {
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
