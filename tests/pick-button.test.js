// SPDX-License-Identifier: GPL-3.0-or-later
// The custom settings widget for "pick-window" (files/window-memory@bootkicker/pick_button.py).
// The file checks run anywhere. The widget test needs python3 with GTK 3 and a display; it
// skips itself without them. It never talks to the real Cinnamon: see the harness.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const extDir = path.join(__dirname, '..', 'files', 'window-memory@bootkicker');
const file = path.join(extDir, 'pick_button.py');
const harness = path.join(__dirname, 'helpers', 'pick_button_harness.py');
const SKIP_EXIT = 77;
const hasPython = !spawnSync('python3', ['--version']).error;

test('pick_button.py starts with the SPDX line and names the uuid of the extension', () => {
    const src = fs.readFileSync(file, 'utf8');
    assert.equal(src.split('\n')[0], '# SPDX-License-Identifier: GPL-3.0-or-later');
    const meta = JSON.parse(fs.readFileSync(path.join(extDir, 'metadata.json'), 'utf8'));
    assert.equal(/^UUID = '([^']+)'$/m.exec(src)[1], meta.uuid);
});

test('pick_button.py is valid Python 3', (t) => {
    if (!hasPython) return t.skip('python3 is not installed');
    // The compiled file goes to a temp dir, so no __pycache__ appears in the extension folder.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-button-'));
    try {
        const r = spawnSync('python3', ['-B', '-c',
            'import py_compile, sys; py_compile.compile(sys.argv[1], cfile=sys.argv[2], doraise=True)',
            file, path.join(tmp, 'pick_button.pyc')], { encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('the "Max windows" spin button of the list toolbar has the range and step of max-entries in the schema, and is bound to that key both ways', () => {
    const src = fs.readFileSync(file, 'utf8');
    const schema = JSON.parse(fs.readFileSync(path.join(extDir, 'settings-schema.json'), 'utf8'));
    const constant = (name) => Number(new RegExp('^' + name + ' = (\\d+)$', 'm').exec(src)[1]);
    const spin = schema['max-entries'];
    assert.equal(constant('MAX_ENTRIES_MIN'), spin.min);
    assert.equal(constant('MAX_ENTRIES_MAX'), spin.max);
    assert.equal(constant('MAX_ENTRIES_STEP'), spin.step);
    assert.match(src, /^MAX_ENTRIES_KEY = 'max-entries'$/m);
    assert.match(src, /self\.settings\.bind\(MAX_ENTRIES_KEY, spin, 'value', Gio\.SettingsBindFlags\.DEFAULT/);
    assert.match(src, /Gtk\.Label\(label=_\('Max windows'\)\)/);
    assert.match(src, /_\('Maximum remembered windows\. The least recently seen windows are dropped first\.'\)/);
});

test('the widget builds like cinnamon-settings builds it, shows the icon and a theme-coloured border, sends the callback, greys out every row of the page (the forget-all row too) except the version row while "enabled" is off, and makes the never-remember list two thirds as high, as wide as before and still scrollable; a list whose height request cannot be read or is zero, or whose row holds two scrolled windows, keeps its height and a warning is logged', (t) => {
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
