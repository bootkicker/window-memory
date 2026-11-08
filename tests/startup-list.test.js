// SPDX-License-Identifier: GPL-3.0-or-later
// The file logic of the "Startup apps" tab (files/window-memory@bootkicker/startup_list.py):
// which startup entries are listed, the switch, Remove, the pick of an application and its Undo,
// and the custom entry. It needs python3 with GLib (gi) but no GTK and no display. Then the widget
// of the tab (class StartupList in the same file), which needs GTK 3 and a display and skips itself
// without them. Neither reads or writes the real autostart folder or configuration, and the widget
// never talks to the real Cinnamon: see the two harnesses.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const extDir = path.join(__dirname, '..', 'files', 'window-memory@bootkicker');
const file = path.join(extDir, 'startup_list.py');
const harness = path.join(__dirname, 'helpers', 'startup_list_harness.py');
const gtkHarness = path.join(__dirname, 'helpers', 'startup_list_gtk_harness.py');
const SKIP_EXIT = 77;
const hasPython = !spawnSync('python3', ['--version']).error;

test('startup_list.py starts with the SPDX line and names the uuid of the extension', () => {
    const src = fs.readFileSync(file, 'utf8');
    assert.equal(src.split('\n')[0], '# SPDX-License-Identifier: GPL-3.0-or-later');
    const meta = JSON.parse(fs.readFileSync(path.join(extDir, 'metadata.json'), 'utf8'));
    assert.equal(/^UUID = '([^']+)'$/m.exec(src)[1], meta.uuid);
});

test('startup_list.py is valid Python 3', (t) => {
    if (!hasPython) return t.skip('python3 is not installed');
    // The compiled file goes to a temp dir, so no __pycache__ appears in the extension folder.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-list-'));
    try {
        const r = spawnSync('python3', ['-B', '-c',
            'import py_compile, sys; py_compile.compile(sys.argv[1], cfile=sys.argv[2], doraise=True)',
            file, path.join(tmp, 'startup_list.pyc')], { encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('the startup entries logic lists, switches, removes, adds (added, already on, switched on, restored), undoes and creates custom entries as the system tool does, in temporary folders only', (t) => {
    if (!hasPython) return t.skip('python3 is not installed');
    const r = spawnSync('python3', ['-B', harness, extDir], { encoding: 'utf8' });
    if (r.status === SKIP_EXIT) return t.skip(r.stdout.trim());
    assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('the tab widget lists the entries with their switches, removes, sends the pick call, adds a picked application with Undo or opens the filled-in form, opens Startup Applications, follows "Enable Window Memory" and the autostart folder, and never raises, in temporary folders only', (t) => {
    if (!hasPython) return t.skip('python3 is not installed');
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return t.skip('no display');
    const r = spawnSync('python3', ['-B', gtkHarness, extDir], {
        encoding: 'utf8',
        // An unreachable session bus: even a bug cannot call the real Cinnamon.
        env: Object.assign({}, process.env, { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent' }),
    });
    if (r.status === SKIP_EXIT) return t.skip(r.stdout.trim());
    assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('the pick button of the tab has the same icon and fallback glyph as the General tab pick button', () => {
    const pick = fs.readFileSync(path.join(extDir, 'pick_button.py'), 'utf8');
    const startup = fs.readFileSync(file, 'utf8');
    const icon = /^ICON_NAME = '([^']+)'$/m.exec(pick)[1];
    const glyph = /^FALLBACK_GLYPH = '([^']+)'/m.exec(pick)[1];
    assert.equal(/^PICK_ICON_NAME = '([^']+)'$/m.exec(startup)[1], icon);
    assert.equal(/^PICK_ICON_FALLBACK = '([^']+)'/m.exec(startup)[1], glyph);
});
