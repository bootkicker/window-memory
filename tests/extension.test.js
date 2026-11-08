const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { install } = require('./helpers/cinnamon-mock.js');
const Store = require('../files/window-memory@bootkicker/lib/store.js');

const EXT = path.join(__dirname, '..', 'files', 'window-memory@bootkicker', 'extension.js');
const HOTKEY = 'window-memory-forget-focused';

function load(env) {
    delete require.cache[EXT];
    const ext = require(EXT);
    ext.init({ uuid: 'window-memory@bootkicker' });
    const callbacks = ext.enable();
    return { ext, callbacks };
}

// Cinnamon 6.8 loads the main file of an extension with its native importer (ui/extension.js:519 at tag 6.8.0): there
// `module` is undefined (only require() gives one, :98-106, :219), and the importer exports the top-level functions.
// This evaluates extension.js that way: `module` undefined, require() still there for lib/, and the three top-level
// functions read from the scope the file defines.
function loadNative() {
    const { createRequire } = require('node:module');
    const src = fs.readFileSync(EXT, 'utf8');
    const run = new Function('require', 'module',
        src + '\n;return { init: typeof init === "function" ? init : undefined, enable: typeof enable === "function" ? enable : undefined,'
        + ' disable: typeof disable === "function" ? disable : undefined };');
    return run(createRequire(EXT), undefined);
}

function readState(env) {
    return JSON.parse(fs.readFileSync(env.statePath, 'utf8'));
}

function seedState(env, windows) {
    fs.mkdirSync(path.dirname(env.statePath), { recursive: true });
    fs.writeFileSync(env.statePath, JSON.stringify({ version: 1, windows: windows }));
}

function seedEntry(over) {
    return Object.assign({
        id: 'e1', key: 'firefox|navigator', wmClass: 'Firefox', instance: 'Navigator', role: '', title: '',
        lastSeen: 1, workspace: 0, maximized: false,
        monitor: { index: 0, x: 0, y: 0, w: 1920, h: 1080 }, rel: { x: 100, y: 50, w: 800, h: 600 },
    }, over || {});
}

// Opens a window the way Cinnamon does: window-created, then the first map.
function open(env, w) {
    env.display.emit('window-created', env.display, w);
    env.mapWindow(w);
}

// Makes moving the file at a path ending in `suffix` fail, as a full or read-only disk would.
function failMovesFrom(suffix) {
    const Gio = globalThis.imports.gi.Gio;
    const orig = Gio.File.new_for_path;
    Gio.File.new_for_path = p => {
        const f = orig(p);
        if (p.endsWith(suffix)) f.move = () => { throw new Error('rename refused'); };
        return f;
    };
}

// Makes reading the file at a path ending in `suffix` fail, as a file the user may not read would.
function failReadsFrom(suffix) {
    const Gio = globalThis.imports.gi.Gio;
    const orig = Gio.File.new_for_path;
    Gio.File.new_for_path = p => {
        const f = orig(p);
        if (p.endsWith(suffix)) f.load_contents = () => { throw new Error('Permission denied'); };
        return f;
    };
}

// Makes deleting the file at a path ending in `suffix` fail, as a folder the user may not write to would.
function failDeletesFrom(suffix) {
    const Gio = globalThis.imports.gi.Gio;
    const orig = Gio.File.new_for_path;
    Gio.File.new_for_path = p => {
        const f = orig(p);
        if (p.endsWith(suffix)) f.delete = () => { throw new Error('Permission denied'); };
        return f;
    };
}

// Returns a list that receives the path of every file read through the mock's Gio from now on.
function recordReads() {
    const Gio = globalThis.imports.gi.Gio;
    const orig = Gio.File.new_for_path;
    const reads = [];
    Gio.File.new_for_path = p => {
        const f = orig(p);
        const load = f.load_contents;
        f.load_contents = (...args) => {
            reads.push(p);
            return load(...args);
        };
        return f;
    };
    return reads;
}

// Records the text of every state-file write that the mock's fs sees (the file is written as state.json.tmp, then renamed).
function recordWrites() {
    const orig = fs.writeFileSync;
    const writes = [];
    fs.writeFileSync = function (p, data, ...rest) {
        if (String(p).endsWith('state.json.tmp')) writes.push(String(data));
        return orig.call(this, p, data, ...rest);
    };
    return { writes: writes, stop() { fs.writeFileSync = orig; } };
}

// Holds the clock still: entries carry lastSeen in whole seconds, so a repeated capture is only identical within one second.
function freezeClock() {
    const orig = Date.now;
    Date.now = () => 1760000000000;
    return { stop() { Date.now = orig; } };
}

test('a user move is saved and restored on the next open', () => {
    const env = install();
    let s = load(env);
    const w1 = env.makeWindow({ frame: { x: 100, y: 100, width: 800, height: 600 } });
    env.display.emit('window-created', env.display, w1);
    env.mapWindow(w1);
    w1.frame = { x: 300, y: 200, width: 900, height: 700 };
    env.display.emit('grab-op-end', env.display, w1);
    env.runTimers();
    const saved = readState(env).windows[0];
    assert.deepEqual(saved.rel, { x: 300, y: 200, w: 900, h: 700 });
    assert.equal(saved.key, 'firefox|navigator');
    s.ext.disable();

    s = load(env);
    const w2 = env.makeWindow({ frame: { x: 0, y: 0, width: 400, height: 300 } });
    env.display.emit('window-created', env.display, w2);
    env.mapWindow(w2);
    assert.deepEqual(w2.moves, [[300, 200, 900, 700]]);
    assert.equal(env.errors, undefined);
});

test('a window whose role changes on every launch is restored by its class and instance', () => {
    const env = install();
    let s = load(env);
    const first = env.makeWindow({
        wmClass: 'Xed', instance: 'xed', role: 'xed-window-1760000000-4242-0-host',
        frame: { x: 100, y: 100, width: 800, height: 600 },
    });
    open(env, first);
    first.frame = { x: 300, y: 200, width: 900, height: 700 };
    env.display.emit('grab-op-end', env.display, first);
    env.runTimers();
    const saved = readState(env).windows[0];
    assert.equal(saved.key, 'xed|xed');
    assert.equal(saved.role, 'xed-window-1760000000-4242-0-host'); // kept for information only
    s.ext.disable();

    s = load(env);
    const second = env.makeWindow({
        wmClass: 'Xed', instance: 'xed', role: 'xed-window-1760000099-4343-0-host',
        frame: { x: 0, y: 0, width: 400, height: 300 },
    });
    open(env, second);
    assert.deepEqual(second.moves, [[300, 200, 900, 700]]);
    assert.equal(env.errors, undefined);
});

test('a saved monitor that is gone falls back to the primary and the rect is clamped', () => {
    const env = install();
    seedState(env, [seedEntry({
        monitor: { index: 1, x: 1920, y: 0, w: 1920, h: 1080 }, rel: { x: 1500, y: 900, w: 800, h: 600 },
    })]);
    load(env);
    const w = env.makeWindow({});
    env.display.emit('window-created', env.display, w);
    env.mapWindow(w);
    assert.deepEqual(w.moves, [[1120, 480, 800, 600]]);
});

test('remember-size off keeps the current size but still restores position', () => {
    const env = install({ settings: { 'remember-size': false } });
    seedState(env, [seedEntry()]);
    load(env);
    const w = env.makeWindow({ frame: { x: 0, y: 0, width: 1000, height: 700 } });
    env.display.emit('window-created', env.display, w);
    env.mapWindow(w);
    assert.deepEqual(w.moves, [[100, 50, 1000, 700]]);
});

test('excluded apps and dialogs are never remembered or moved', () => {
    const env = install({ settings: { 'excluded-apps': [{ wmclass: 'firefox' }] } });
    load(env);
    const excluded = env.makeWindow({});
    const dialog = env.makeWindow({ wmClass: 'Gedit', type: 1 });
    for (const w of [excluded, dialog]) {
        env.display.emit('window-created', env.display, w);
        env.mapWindow(w);
        w.frame = { x: 5, y: 5, width: 300, height: 200 };
        env.display.emit('grab-op-end', env.display, w);
    }
    env.runTimers();
    assert.deepEqual(excluded.moves, []);
    assert.deepEqual(dialog.moves, []);
    assert.equal(fs.existsSync(env.statePath) ? readState(env).windows.length : 0, 0);
});

test('an unchecked row of excluded-apps does not exclude: the window is remembered; a checked row or one with no enabled does', () => {
    const run = rows => {
        const env = install({ settings: { 'excluded-apps': rows } });
        load(env);
        const w = env.makeWindow({});
        open(env, w);
        env.display.emit('grab-op-end', env.display, w);
        env.runTimers();
        return fs.existsSync(env.statePath) ? readState(env).windows.length : 0;
    };
    assert.equal(run([{ enabled: false, wmclass: 'firefox' }]), 1);
    assert.equal(run([{ enabled: false, wmclass: 'firefox' }, { enabled: true, wmclass: 'fire' }]), 0);
    assert.equal(run([{ enabled: true, wmclass: 'firefox' }]), 0);
    assert.equal(run([{ wmclass: 'firefox' }]), 0);
});

test('excluded apps match WM_CLASS only, not the instance or the title', () => {
    const env = install({ settings: { 'excluded-apps': [{ wmclass: 'navigator' }, { wmclass: 'page' }] } });
    load(env);
    const w = env.makeWindow({ wmClass: 'Firefox', instance: 'Navigator', title: 'Page' });
    open(env, w);
    env.display.emit('grab-op-end', env.display, w);
    env.runTimers();
    assert.equal(readState(env).windows.length, 1);
});

test('two windows of one app restore to two different saved entries', () => {
    const env = install();
    const entry = (id, lastSeen, x) => seedEntry({ id: id, lastSeen: lastSeen, rel: { x: x, y: 0, w: 500, h: 400 } });
    seedState(env, [entry('old', 1, 10), entry('new', 2, 20)]);
    load(env);
    const a = env.makeWindow({});
    const b = env.makeWindow({});
    for (const w of [a, b]) {
        env.display.emit('window-created', env.display, w);
        env.mapWindow(w);
    }
    assert.deepEqual(a.moves, [[20, 0, 500, 400]]);
    assert.deepEqual(b.moves, [[10, 0, 500, 400]]);
});

test('a restored window updates its own entry instead of adding a new one', () => {
    const env = install();
    seedState(env, [seedEntry({ id: 'old' })]);
    load(env);
    const w = env.makeWindow({});
    open(env, w);
    w.frame = { x: 60, y: 70, width: 500, height: 400 };
    w.emit('position-changed', w);
    env.runTimers();
    const windows = readState(env).windows;
    assert.equal(windows.length, 1);
    assert.equal(windows[0].id, 'old');
    assert.deepEqual(windows[0].rel, { x: 60, y: 70, w: 500, h: 400 });
});

test('a window the user moves between window-created and its first map is not moved back at the map', () => {
    const env = install();
    seedState(env, [seedEntry()]);
    load(env);
    const w = env.makeWindow({});
    env.display.emit('window-created', env.display, w);
    assert.equal(w.moves.length, 1); // restored at once, before anyone could have moved it
    w.frame = { x: 5, y: 5, width: 300, height: 200 };
    env.display.emit('grab-op-end', env.display, w);
    env.mapWindow(w);
    assert.equal(w.moves.length, 1);
    assert.deepEqual(w.frame, { x: 5, y: 5, width: 300, height: 200 });
});

test('windows open when the extension is enabled are tracked but never restored', () => {
    const env = install();
    seedState(env, [seedEntry()]);
    const w = env.makeWindow({});
    env.windows.push(w);
    load(env);
    env.mapWindow(w);
    assert.deepEqual(w.moves, []);
    w.frame = { x: 40, y: 40, width: 500, height: 400 };
    w.emit('size-changed', w);
    env.runTimers();
    const windows = readState(env).windows;
    assert.equal(windows.length, 1); // the open window took over its saved entry instead of adding one
    assert.equal(windows[0].id, 'e1');
    assert.deepEqual(windows[0].rel, { x: 40, y: 40, w: 500, h: 400 });
});

test('a window that was already open holds its claim: a second window of the app is not moved onto it', () => {
    const env = install();
    seedState(env, [seedEntry()]);
    const first = env.makeWindow({ frame: { x: 100, y: 50, width: 800, height: 600 } });
    env.windows.push(first);
    load(env);
    const second = env.makeWindow({});
    open(env, second);
    assert.deepEqual(second.moves, []);
    first.emit('unmanaging', first);
    first.emit('unmanaged', first);
    const windows = readState(env).windows.filter(e => e.key === 'firefox|navigator');
    assert.equal(windows.length, 1);
    assert.equal(windows[0].id, 'e1');
});

test('a window may be mapped with no workspace yet: restore and capture still work', () => {
    const env = install();
    seedState(env, [seedEntry({ rel: { x: 1500, y: 900, w: 800, h: 600 } })]);
    load(env);
    const w = env.makeWindow({});
    w.get_workspace = () => null;
    open(env, w);
    assert.deepEqual(w.moves, [[1120, 480, 800, 600]]);
    w.emit('position-changed', w);
    env.runTimers();
    assert.equal(readState(env).windows[0].workspace, null);
    assert.equal(env.errors, undefined);
});

test('grab-op-end finds the window among (emitter, display, window, op) and ignores events without one', () => {
    const env = install();
    load(env);
    const w = env.makeWindow({});
    open(env, w);
    env.display.focus_window = w; // must not be used as a fallback
    env.display.emit('grab-op-end', env.display, env.display, null, 1);
    env.display.emit('grab-op-end', env.display, env.display, undefined, 1);
    env.runTimers();
    assert.equal(fs.existsSync(env.statePath), false);
    w.frame = { x: 40, y: 50, width: 500, height: 400 };
    env.display.emit('grab-op-end', env.display, env.display, w, 1);
    env.runTimers();
    assert.deepEqual(readState(env).windows[0].rel, { x: 40, y: 50, w: 500, h: 400 });
    assert.equal(env.errors, undefined);
});

test('map ignores an actor that is missing or not tracked', () => {
    const env = install();
    load(env);
    env.wm.emit('map', env.wm, null);
    env.wm.emit('map', env.wm, undefined);
    env.wm.emit('map', env.wm, env.makeWindow({}).get_compositor_private());
    assert.equal(env.errors, undefined);
});

test('every saved entry carries rel, monitor, maximized, minimized and workspace, using null when unknown', () => {
    const env = install();
    load(env);
    const w = env.makeWindow({ maximized: 3 });
    w.is_on_all_workspaces = () => true;
    open(env, w);
    env.display.emit('grab-op-end', env.display, w);
    env.runTimers();
    const text = fs.readFileSync(env.statePath, 'utf8');
    const entry = JSON.parse(text).windows[0];
    for (const field of ['rel', 'monitor', 'maximized', 'minimized', 'workspace']) assert.ok(field in entry, field + ' is present');
    assert.equal(entry.rel, null); // maximized at first sight: no normal geometry is known
    assert.deepEqual(entry.monitor, { index: 0, x: 0, y: 0, w: 1920, h: 1080 }); // but the monitor is
    assert.equal(entry.workspace, null);
    assert.equal(entry.maximized, true);
    assert.equal(entry.minimized, false); // a boolean always, never null: this window was never minimized
    assert.equal(Store.parseState(text).state.windows.length, 1); // the strict loader keeps it
});

test('a maximized window keeps the geometry it had before being maximized', () => {
    const env = install();
    load(env);
    const w = env.makeWindow({ frame: { x: 120, y: 80, width: 700, height: 500 } });
    open(env, w);
    env.display.emit('grab-op-end', env.display, w);
    w.maximized = 3;
    w.frame = { x: 0, y: 0, width: 1920, height: 1080 };
    w.emit('size-changed', w);
    env.runTimers();
    const entry = readState(env).windows[0];
    assert.equal(entry.maximized, true);
    assert.deepEqual(entry.rel, { x: 120, y: 80, w: 700, h: 500 });
});

test('a saved maximized window is maximized again', () => {
    const env = install();
    seedState(env, [seedEntry({ maximized: true })]);
    load(env);
    const w = env.makeWindow({});
    open(env, w);
    assert.equal(w.maximized, 3);
});

test('a corrupt state file is moved aside and the extension still enables', () => {
    const env = install();
    fs.mkdirSync(path.dirname(env.statePath), { recursive: true });
    fs.writeFileSync(env.statePath, '{broken');
    load(env);
    const dir = path.dirname(env.statePath);
    assert.ok(fs.readdirSync(dir).some(f => f.startsWith('state.json.bad-')));
    assert.equal(env.errors, undefined);
});

test('a state file that cannot be read is moved aside before any save, and the error is logged', () => {
    const env = install();
    // A directory where the file should be: it exists but cannot be read as a file.
    fs.mkdirSync(env.statePath, { recursive: true });
    fs.writeFileSync(path.join(env.statePath, 'marker'), 'keep me');
    load(env);
    const dir = path.dirname(env.statePath);
    const aside = fs.readdirSync(dir).filter(f => f.startsWith('state.json.bad-'));
    assert.equal(aside.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, aside[0], 'marker'), 'utf8'), 'keep me');
    assert.ok(env.errors.some(e => e.includes('state file')), 'logged through global.logError');

    const w = env.makeWindow({});
    open(env, w);
    env.display.emit('grab-op-end', env.display, w);
    env.runTimers();
    assert.equal(readState(env).windows.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, aside[0], 'marker'), 'utf8'), 'keep me');
});

test('if an unreadable state file cannot be moved aside, nothing is saved over it', () => {
    const env = install();
    fs.mkdirSync(env.statePath, { recursive: true });
    failMovesFrom('/state.json');
    const s = load(env);
    assert.ok(env.errors.length >= 1);
    const w = env.makeWindow({});
    open(env, w);
    env.display.emit('grab-op-end', env.display, w);
    env.runTimers();
    s.ext.disable();
    const dir = path.dirname(env.statePath);
    assert.ok(fs.statSync(env.statePath).isDirectory(), 'the original is untouched');
    assert.deepEqual(fs.readdirSync(dir).filter(f => f !== 'safety.json'), ['state.json']);
});

test('if a corrupt state file cannot be moved aside, nothing is saved over it', () => {
    const env = install();
    fs.mkdirSync(path.dirname(env.statePath), { recursive: true });
    fs.writeFileSync(env.statePath, '{broken');
    failMovesFrom('/state.json');
    const s = load(env);
    const w = env.makeWindow({});
    open(env, w);
    env.display.emit('grab-op-end', env.display, w);
    env.runTimers();
    s.ext.disable();
    assert.equal(fs.readFileSync(env.statePath, 'utf8'), '{broken');
    assert.deepEqual(fs.readdirSync(path.dirname(env.statePath)).filter(f => f !== 'safety.json'), ['state.json']);
});

test('disable flushes a pending save and disconnects display signals', () => {
    const env = install();
    const s = load(env);
    const w = env.makeWindow({});
    env.display.emit('window-created', env.display, w);
    env.mapWindow(w);
    w.frame = { x: 40, y: 40, width: 500, height: 400 };
    env.display.emit('grab-op-end', env.display, w);
    s.ext.disable();
    assert.equal(readState(env).windows.length, 1);
    assert.equal(env.display.handlers['grab-op-end'].length, 0);
});

test('disable releases every handler, the hotkey and the settings', () => {
    const env = install({ settings: { 'forget-focused': '<Super>f' } });
    const open1 = env.makeWindow({});
    env.windows.push(open1);
    const s = load(env);
    const w = env.makeWindow({});
    open(env, w);
    assert.ok(env.hotkeys[HOTKEY]);
    s.ext.disable();
    for (const win of [open1, w]) {
        for (const sig of ['position-changed', 'size-changed', 'notify::minimized', 'shown', 'unmanaging', 'unmanaged'])
            assert.equal(win.handlers[sig].length, 0, sig);
    }
    assert.equal(env.display.handlers['window-created'].length, 0);
    assert.equal(env.wm.handlers.map.length, 0);
    assert.equal(env.hotkeys[HOTKEY], undefined);
    assert.equal(env.settingsFinalized, true);
    assert.equal(env.timers.size, 0);
    assert.equal(env.errors, undefined);
});

test('closing a window captures it one last time, saves at once and releases its handlers', () => {
    const env = install();
    load(env);
    const w = env.makeWindow({});
    open(env, w);
    w.frame = { x: 70, y: 80, width: 600, height: 450 };
    w.emit('unmanaging', w);
    w.emit('unmanaged', w);
    assert.deepEqual(readState(env).windows[0].rel, { x: 70, y: 80, w: 600, h: 450 });
    assert.equal(env.timers.size, 0);
    assert.equal(w.handlers['position-changed'].length, 0);
});

test('forget-focused is registered from the setting, re-bound when it changes and forgets the focused window', () => {
    const env = install({ settings: { 'forget-focused': '<Super>f' } });
    const s = load(env);
    assert.equal(env.hotkeys[HOTKEY].accel, '<Super>f');
    env.changeSetting('forget-focused', '<Super>g');
    assert.equal(env.hotkeys[HOTKEY].accel, '<Super>g');
    env.changeSetting('forget-focused', '');
    assert.equal(env.hotkeys[HOTKEY], undefined);
    env.changeSetting('forget-focused', '<Super>h');
    assert.equal(env.hotkeys[HOTKEY].accel, '<Super>h');

    const w = env.makeWindow({});
    open(env, w);
    env.display.emit('grab-op-end', env.display, w);
    env.runTimers();
    assert.equal(readState(env).windows.length, 1);
    env.display.focus_window = w;
    env.hotkeys[HOTKEY].callback();
    env.runTimers();
    assert.equal(readState(env).windows.length, 0);
    s.ext.disable();
    assert.equal(env.hotkeys[HOTKEY], undefined);
    assert.equal(env.errors, undefined);
});

test('forget-focused with no hotkey set registers nothing', () => {
    const env = install();
    load(env);
    assert.equal(env.hotkeys[HOTKEY], undefined);
});

test('turning the extension on tracks the windows that are already open', () => {
    const env = install({ settings: { enabled: false } });
    const w = env.makeWindow({});
    env.windows.push(w);
    load(env);
    env.display.emit('grab-op-end', env.display, w);
    env.runTimers();
    assert.equal(fs.existsSync(env.statePath), false);
    env.changeSetting('enabled', true);
    env.display.emit('grab-op-end', env.display, w);
    env.runTimers();
    assert.equal(readState(env).windows.length, 1);
});

test('forgetAll empties the saved state', () => {
    const env = install();
    const s = load(env);
    const w = env.makeWindow({});
    env.display.emit('window-created', env.display, w);
    env.mapWindow(w);
    env.display.emit('grab-op-end', env.display, w);
    env.runTimers();
    assert.equal(readState(env).windows.length, 1);
    s.callbacks.forgetAll();
    env.runTimers();
    assert.equal(readState(env).windows.length, 0);
});

test('captures that leave the state unchanged write the file once, and a real change writes it again', () => {
    const env = install();
    load(env);
    const rec = recordWrites();
    const clock = freezeClock();
    try {
        const w = env.makeWindow({});
        open(env, w);
        env.display.emit('grab-op-end', env.display, w);
        env.runTimers();
        assert.equal(rec.writes.length, 1);

        env.display.emit('grab-op-end', env.display, w); // same frame, same second: the same state
        env.runTimers();
        assert.equal(rec.writes.length, 1);

        w.frame = { x: 300, y: 200, width: 900, height: 700 };
        env.display.emit('grab-op-end', env.display, w);
        env.runTimers();
        assert.equal(rec.writes.length, 2);
        assert.deepEqual(readState(env).windows[0].rel, { x: 300, y: 200, w: 900, h: 700 });
        assert.equal(env.errors, undefined);
    } finally {
        clock.stop();
        rec.stop();
    }
});

test('the first save after enable writes even when the file already holds the same state', () => {
    const env = install();
    fs.mkdirSync(path.dirname(env.statePath), { recursive: true });
    fs.writeFileSync(env.statePath, Store.serializeState(Store.emptyState()));
    const s = load(env);
    const rec = recordWrites();
    try {
        s.callbacks.forgetAll(); // the state stays empty, which is what the file holds
        env.runTimers();
        assert.equal(rec.writes.length, 1);
        s.callbacks.forgetAll();
        env.runTimers();
        assert.equal(rec.writes.length, 1);
    } finally {
        rec.stop();
    }
});

test('a write that failed is tried again at the next save, though the state has not changed', () => {
    const env = install();
    const s = load(env);
    const Gio = globalThis.imports.gi.Gio;
    const working = Gio.File.new_for_path;
    const rec = recordWrites();
    try {
        failMovesFrom('state.json.tmp');
        s.callbacks.forgetAll(); // forgetAll writes at once, and its debounced save is the next save
        env.runTimers();
        s.callbacks.forgetAll();
        env.runTimers();
        assert.equal(rec.writes.length, 4, 'every save after a failed one tried again');
        assert.equal(env.errors.length, 4);
        assert.equal(fs.existsSync(env.statePath), false);

        Gio.File.new_for_path = working;
        s.callbacks.forgetAll();
        env.runTimers();
        assert.equal(rec.writes.length, 5); // written at once; the debounced save then finds nothing new to write
        assert.deepEqual(readState(env).windows, []);
    } finally {
        rec.stop();
    }
});

test('forget-focused is not undone when the window closes, and a reopened window gets no moves', () => {
    const env = install();
    let s = load(env);
    const w = env.makeWindow({});
    open(env, w);
    w.frame = { x: 40, y: 50, width: 500, height: 400 };
    env.display.emit('grab-op-end', env.display, w);
    env.runTimers();
    assert.equal(readState(env).windows.length, 1);

    env.display.focus_window = w;
    s.callbacks.forgetFocused();
    w.emit('unmanaging', w);
    w.emit('unmanaged', w);
    assert.equal(readState(env).windows.length, 0);
    s.ext.disable();

    s = load(env);
    const again = env.makeWindow({});
    open(env, again);
    assert.deepEqual(again.moves, []);
});

test('forget-focused pauses the window until the user drags or resizes it again', () => {
    const env = install();
    const s = load(env);
    const w = env.makeWindow({});
    open(env, w);
    env.display.emit('grab-op-end', env.display, w);
    env.runTimers();
    env.display.focus_window = w;
    s.callbacks.forgetFocused();
    env.runTimers();
    assert.equal(readState(env).windows.length, 0);

    w.frame = { x: 10, y: 10, width: 400, height: 300 };
    w.emit('size-changed', w); // the app or the system moving it does not count
    env.runTimers();
    assert.equal(readState(env).windows.length, 0);

    w.frame = { x: 60, y: 70, width: 450, height: 350 };
    env.display.emit('grab-op-end', env.display, w); // an explicit drag does
    env.runTimers();
    const windows = readState(env).windows;
    assert.equal(windows.length, 1);
    assert.deepEqual(windows[0].rel, { x: 60, y: 70, w: 450, h: 350 });
});

test('forget-focused on a window with no saved entry still keeps it from being saved on close', () => {
    const env = install();
    const s = load(env);
    const w = env.makeWindow({});
    open(env, w);
    env.display.focus_window = w;
    s.callbacks.forgetFocused();
    w.emit('unmanaging', w);
    w.emit('unmanaged', w);
    env.runTimers();
    assert.equal(fs.existsSync(env.statePath) ? readState(env).windows.length : 0, 0);
});

test('forgetAll is not undone by the next capture or by closing a window', () => {
    const env = install();
    const s = load(env);
    const a = env.makeWindow({});
    const b = env.makeWindow({ wmClass: 'Gedit', instance: 'gedit' });
    for (const w of [a, b]) {
        open(env, w);
        env.display.emit('grab-op-end', env.display, w);
    }
    env.runTimers();
    assert.equal(readState(env).windows.length, 2);

    s.callbacks.forgetAll();
    a.frame = { x: 5, y: 5, width: 300, height: 200 };
    a.emit('size-changed', a);
    env.runTimers();
    assert.equal(readState(env).windows.length, 0);
    a.emit('unmanaging', a);
    a.emit('unmanaged', a);
    assert.equal(readState(env).windows.length, 0);

    b.frame = { x: 80, y: 90, width: 420, height: 310 };
    env.display.emit('grab-op-end', env.display, b); // an explicit drag teaches b again
    env.runTimers();
    const windows = readState(env).windows;
    assert.equal(windows.length, 1);
    assert.equal(windows[0].key, 'gedit|gedit');
});

test('turning on include-dialogs tracks a dialog that is already open', () => {
    const env = install({ settings: { 'include-dialogs': false } });
    const dialog = env.makeWindow({ wmClass: 'Gedit', instance: 'gedit', type: 1 });
    env.windows.push(dialog);
    load(env);
    env.display.emit('grab-op-end', env.display, dialog);
    env.runTimers();
    assert.equal(fs.existsSync(env.statePath), false);
    env.changeSetting('include-dialogs', true);
    env.display.emit('grab-op-end', env.display, dialog);
    env.runTimers();
    assert.equal(readState(env).windows.length, 1);
});

test('removing an app from excluded-apps tracks its windows that are already open', () => {
    const env = install({ settings: { 'excluded-apps': [{ wmclass: 'firefox' }] } });
    const w = env.makeWindow({});
    env.windows.push(w);
    load(env);
    env.display.emit('grab-op-end', env.display, w);
    env.runTimers();
    assert.equal(fs.existsSync(env.statePath), false);
    env.changeSetting('excluded-apps', []);
    env.display.emit('grab-op-end', env.display, w);
    env.runTimers();
    assert.equal(readState(env).windows.length, 1);
});

test('position and size changes are captured once the window has been idle, not on every event', () => {
    const env = install();
    load(env);
    const w = env.makeWindow({});
    const other = env.makeWindow({ wmClass: 'Gedit', instance: 'gedit' });
    open(env, w);
    open(env, other);
    const rects = [
        { x: 10, y: 10, width: 400, height: 300 },
        { x: 20, y: 20, width: 450, height: 350 },
        { x: 30, y: 30, width: 500, height: 400 },
    ];
    for (const r of rects) {
        w.frame = r;
        w.emit('size-changed', w);
        w.emit('position-changed', w);
    }
    assert.equal(env.timers.size, 1); // one pending idle timer: each event reset it
    // Another window closing flushes the file, which shows what has been captured so far: nothing of w.
    other.emit('unmanaging', other);
    other.emit('unmanaged', other);
    assert.deepEqual(readState(env).windows.map(e => e.key), ['gedit|gedit']);
    env.runTimers();
    const windows = readState(env).windows.filter(e => e.key === 'firefox|navigator');
    assert.equal(windows.length, 1);
    assert.deepEqual(windows[0].rel, { x: 30, y: 30, w: 500, h: 400 });
});

test('grab-op-end captures at once and cancels the pending idle capture', () => {
    const env = install();
    load(env);
    const w = env.makeWindow({});
    open(env, w);
    w.frame = { x: 10, y: 10, width: 400, height: 300 };
    w.emit('size-changed', w);
    w.frame = { x: 50, y: 60, width: 420, height: 320 };
    env.display.emit('grab-op-end', env.display, w);
    assert.equal(env.timers.size, 1); // only the save timer: the idle timer was cancelled
    env.runTimers();
    assert.deepEqual(readState(env).windows[0].rel, { x: 50, y: 60, w: 420, h: 320 });
});

test('closing a window right after a resize saves the final rect and leaves no timer', () => {
    const env = install();
    load(env);
    const w = env.makeWindow({});
    open(env, w);
    w.frame = { x: 15, y: 25, width: 410, height: 310 };
    w.emit('size-changed', w);
    w.emit('unmanaging', w);
    assert.equal(env.timers.size, 1); // the save timer only: unmanaging cancelled the idle timer
    w.emit('unmanaged', w);
    assert.deepEqual(readState(env).windows[0].rel, { x: 15, y: 25, w: 410, h: 310 });
    assert.equal(env.timers.size, 0);
});

test('disable captures and saves a change that is still waiting for its idle second', () => {
    const env = install();
    const s = load(env);
    const w = env.makeWindow({});
    open(env, w);
    w.frame = { x: 33, y: 44, width: 444, height: 333 };
    w.emit('position-changed', w);
    s.ext.disable();
    assert.deepEqual(readState(env).windows[0].rel, { x: 33, y: 44, w: 444, h: 333 });
    assert.equal(env.timers.size, 0);
    assert.equal(env.errors, undefined);
});

const TWO_MONITORS = [
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: 1920, y: 0, width: 1920, height: 1080 },
];
const MON0 = { x: 0, y: 0, width: 1920, height: 1080 };
const MON1 = { x: 1920, y: 0, width: 1920, height: 1080 };

// Maximizes a window on monitor 1 the way the user would, then closes it.
function maximizeOnSecondMonitorAndClose(env, w) {
    w.monitor = 1;
    w.maximized = 3;
    w.frame = { x: 1920, y: 0, width: 1920, height: 1080 };
    w.emit('size-changed', w);
    w.emit('unmanaging', w);
    w.emit('unmanaged', w);
}

test('a maximized window on the second monitor is saved with that monitor and reopened maximized there', () => {
    const env = install({ monitors: TWO_MONITORS });
    let s = load(env);
    const w = env.makeWindow({});
    open(env, w);
    maximizeOnSecondMonitorAndClose(env, w);
    const saved = readState(env).windows[0];
    assert.equal(saved.maximized, true);
    assert.deepEqual(saved.monitor, { index: 1, x: 1920, y: 0, w: 1920, h: 1080 });
    assert.equal(saved.rel, null); // it never had a normal geometry
    s.ext.disable();

    s = load(env);
    const again = env.makeWindow({}); // the app opens on monitor 0
    open(env, again);
    assert.deepEqual(again.ops, ['move_to_monitor:1', 'maximize']);
    assert.equal(again.monitor, 1);
    assert.equal(again.maximized, 3);
    assert.equal(env.errors, undefined);
});

test('a maximized window keeps its normal geometry but learns the monitor it was maximized on', () => {
    const env = install({ monitors: TWO_MONITORS });
    let s = load(env);
    const w = env.makeWindow({ frame: { x: 120, y: 80, width: 700, height: 500 } });
    open(env, w);
    env.display.emit('grab-op-end', env.display, w); // normal geometry, on monitor 0
    maximizeOnSecondMonitorAndClose(env, w);
    const saved = readState(env).windows[0];
    assert.deepEqual(saved.monitor, { index: 1, x: 1920, y: 0, w: 1920, h: 1080 });
    assert.deepEqual(saved.rel, { x: 120, y: 80, w: 700, h: 500 });
    s.ext.disable();

    s = load(env);
    const again = env.makeWindow({});
    open(env, again);
    assert.deepEqual(again.moves, [[2040, 80, 700, 500]]); // placed on monitor 1, then maximized
    assert.deepEqual(again.ops, ['maximize']); // it has a rel, so it is placed by move_resize_frame instead
});

test('with remember-monitor off a maximized window is not moved to another monitor', () => {
    const env = install({ monitors: TWO_MONITORS, settings: { 'remember-monitor': false } });
    seedState(env, [seedEntry({
        maximized: true, monitor: { index: 1, x: 1920, y: 0, w: 1920, h: 1080 }, rel: null,
    })]);
    load(env);
    const w = env.makeWindow({});
    open(env, w);
    assert.deepEqual(w.ops, ['maximize']);
    assert.equal(w.monitor, 0);
});

test('a fullscreen window keeps both the saved monitor and the saved geometry', () => {
    const env = install({ monitors: TWO_MONITORS });
    seedState(env, [seedEntry({ id: 'fs' })]);
    load(env);
    const w = env.makeWindow({});
    open(env, w);
    w.is_fullscreen = () => true;
    w.monitor = 1;
    w.emit('size-changed', w);
    env.runTimers();
    const saved = readState(env).windows[0];
    assert.equal(saved.monitor.index, 0);
    assert.deepEqual(saved.rel, { x: 100, y: 50, w: 800, h: 600 });
});

test('each monitor has its own work area when a window is restored', () => {
    const env = install({
        monitors: TWO_MONITORS,
        workAreas: { 1: { x: 1920, y: 0, width: 1920, height: 1040 } },
    });
    seedState(env, [seedEntry({
        monitor: { index: 1, x: 1920, y: 0, w: 1920, h: 1080 }, rel: { x: 1500, y: 900, w: 800, h: 600 },
    })]);
    load(env);
    const w = env.makeWindow({});
    open(env, w);
    assert.deepEqual(w.moves, [[3040, 440, 800, 600]]);
});

test('a saved monitor that is unplugged is not overwritten by the fallback monitor, and returns when plugged back in', () => {
    const env = install({ monitors: TWO_MONITORS });
    const onSecond = { index: 1, x: 1920, y: 0, w: 1920, h: 1080 };
    seedState(env, [seedEntry({ monitor: onSecond, rel: { x: 100, y: 50, w: 800, h: 600 } })]);
    load(env);
    const w = env.makeWindow({});
    open(env, w);
    w.monitor = 1;

    // Unplug monitor 1: Muffin moves the window to monitor 0, and a second later the idle capture runs.
    env.setMonitors([MON0]);
    w.monitor = 0;
    w.frame = { x: 500, y: 300, width: 800, height: 600 };
    w.emit('position-changed', w);
    env.runTimers();
    let saved = readState(env).windows[0];
    assert.deepEqual(saved.monitor, onSecond);
    assert.deepEqual(saved.rel, { x: 100, y: 50, w: 800, h: 600 });

    // Closing the window while the monitor is still gone does not overwrite it either.
    w.emit('unmanaging', w);
    w.emit('unmanaged', w);
    saved = readState(env).windows[0];
    assert.deepEqual(saved.monitor, onSecond);

    // Plugged back in: a window on monitor 1 teaches the entry again.
    env.setMonitors(TWO_MONITORS);
    const w2 = env.makeWindow({});
    open(env, w2);
    assert.deepEqual(w2.moves, [[2020, 50, 800, 600]]);
    w2.monitor = 1;
    w2.frame = { x: 2400, y: 200, width: 800, height: 600 };
    env.display.emit('grab-op-end', env.display, w2);
    env.runTimers();
    saved = readState(env).windows[0];
    assert.deepEqual(saved.monitor, onSecond);
    assert.deepEqual(saved.rel, { x: 480, y: 200, w: 800, h: 600 });
});

test('other fields are still updated while a saved monitor is missing', () => {
    const env = install({ monitors: TWO_MONITORS });
    seedState(env, [seedEntry({ monitor: { index: 1, x: 1920, y: 0, w: 1920, h: 1080 } })]);
    load(env);
    const w = env.makeWindow({ title: 'One' });
    open(env, w);
    env.setMonitors([MON0]);
    w.title = 'Two';
    w.workspace = 2;
    w.emit('position-changed', w);
    env.runTimers();
    const saved = readState(env).windows[0];
    assert.equal(saved.title, 'Two');
    assert.equal(saved.workspace, 2);
});

test('a click on the title bar of a forgotten window does not teach it again, a real move does', () => {
    const env = install();
    const s = load(env);
    const w = env.makeWindow({});
    open(env, w);
    env.display.emit('grab-op-end', env.display, w);
    env.runTimers();
    env.display.focus_window = w;
    s.callbacks.forgetFocused();
    env.runTimers();
    assert.equal(readState(env).windows.length, 0);

    // A plain click: the grab begins and ends with the frame unchanged.
    env.display.emit('grab-op-begin', env.display, env.display, w, 1);
    env.display.emit('grab-op-end', env.display, env.display, w, 1);
    env.runTimers();
    assert.equal(readState(env).windows.length, 0);
    w.emit('unmanaging', w);
    w.emit('unmanaged', w);
    assert.equal(readState(env).windows.length, 0);
});

test('a real move after a forget is saved again, and a grab-op-end without a begin still counts', () => {
    const env = install();
    const s = load(env);
    const w = env.makeWindow({});
    open(env, w);
    env.display.emit('grab-op-end', env.display, w);
    env.runTimers();
    env.display.focus_window = w;
    s.callbacks.forgetFocused();
    env.runTimers();
    assert.equal(readState(env).windows.length, 0);

    env.display.emit('grab-op-begin', env.display, env.display, w, 1);
    w.frame = { x: 300, y: 250, width: 800, height: 600 };
    env.display.emit('grab-op-end', env.display, env.display, w, 1);
    env.runTimers();
    let windows = readState(env).windows;
    assert.equal(windows.length, 1);
    assert.deepEqual(windows[0].rel, { x: 300, y: 250, w: 800, h: 600 });

    // No grab-op-begin record for this one: the end event alone is trusted.
    w.frame = { x: 310, y: 260, width: 800, height: 600 };
    env.display.emit('grab-op-end', env.display, env.display, w, 1);
    env.runTimers();
    windows = readState(env).windows;
    assert.deepEqual(windows[0].rel, { x: 310, y: 260, w: 800, h: 600 });
});

test('a resize alone counts as a real grab', () => {
    const env = install();
    load(env);
    const w = env.makeWindow({});
    open(env, w);
    env.display.emit('grab-op-begin', env.display, env.display, w, 1);
    w.frame = { x: 100, y: 100, width: 900, height: 650 };
    env.display.emit('grab-op-end', env.display, env.display, w, 1);
    env.runTimers();
    assert.deepEqual(readState(env).windows[0].rel, { x: 100, y: 100, w: 900, h: 650 });
});

test('grab-op-begin disconnects with the other display signals on disable', () => {
    const env = install();
    const s = load(env);
    assert.equal(env.display.handlers['grab-op-begin'].length, 1);
    s.ext.disable();
    assert.equal(env.display.handlers['grab-op-begin'].length, 0);
});

// A window restored on monitor 1, then monitor 1 is unplugged and Muffin moves the window to monitor 0.
function restoredThenUnplugged() {
    const env = install({ monitors: TWO_MONITORS });
    const onSecond = { index: 1, x: 1920, y: 0, w: 1920, h: 1080 };
    seedState(env, [seedEntry({ monitor: onSecond, rel: { x: 100, y: 50, w: 800, h: 600 } })]);
    load(env);
    const w = env.makeWindow({});
    open(env, w);
    env.setMonitors([MON0]);
    w.monitor = 0;
    return { env: env, w: w, onSecond: onSecond };
}

test('a deliberate drag updates the saved monitor even when that monitor is missing from the layout', () => {
    const { env, w } = restoredThenUnplugged();
    env.display.emit('grab-op-begin', env.display, env.display, w, 1);
    w.frame = { x: 300, y: 200, width: 800, height: 600 };
    env.display.emit('grab-op-end', env.display, env.display, w, 1);
    env.runTimers();
    const saved = readState(env).windows[0];
    assert.deepEqual(saved.monitor, { index: 0, x: 0, y: 0, w: 1920, h: 1080 });
    assert.deepEqual(saved.rel, { x: 300, y: 200, w: 800, h: 600 });
});

test('idle captures and clicks after the same unplug keep the saved monitor', () => {
    const { env, w, onSecond } = restoredThenUnplugged();
    w.frame = { x: 300, y: 200, width: 800, height: 600 };
    w.emit('size-changed', w);
    env.runTimers();
    let saved = readState(env).windows[0];
    assert.deepEqual(saved.monitor, onSecond);
    assert.deepEqual(saved.rel, { x: 100, y: 50, w: 800, h: 600 });

    // A plain click changes no frame, so it is ignored and keeps the saved monitor too.
    env.display.emit('grab-op-begin', env.display, env.display, w, 1);
    env.display.emit('grab-op-end', env.display, env.display, w, 1);
    env.runTimers();
    saved = readState(env).windows[0];
    assert.deepEqual(saved.monitor, onSecond);
});

// Muffin numbers the monitors again after an unplug: with three monitors the one at x 3840 is index 0, and when it is
// unplugged the monitor at x 1920 becomes index 0. A saved monitor must not be taken for the new index 0.
test('an unplugged monitor whose index is taken by another monitor after the renumbering is still kept by idle captures', () => {
    const THREE = [
        { x: 3840, y: 0, width: 1920, height: 1080 },
        { x: 1920, y: 0, width: 1920, height: 1080 },
        { x: 0, y: 0, width: 1920, height: 1080 },
    ];
    const env = install({ monitors: THREE });
    const onFirst = { index: 0, x: 3840, y: 0, w: 1920, h: 1080 };
    seedState(env, [seedEntry({ monitor: onFirst, rel: { x: 160, y: 300, w: 700, h: 426 } })]);
    load(env);
    const w = env.makeWindow({});
    open(env, w);
    env.setMonitors([MON1, MON0]); // the monitor at x 3840 is unplugged: the others are numbered 0 and 1
    w.monitor = 0;
    w.frame = { x: 2080, y: 300, width: 700, height: 426 };
    w.emit('size-changed', w);
    env.runTimers();
    let saved = readState(env).windows[0];
    assert.deepEqual(saved.monitor, onFirst, 'the idle capture keeps the unplugged monitor');
    assert.deepEqual(saved.rel, { x: 160, y: 300, w: 700, h: 426 });

    // A deliberate drag onto a remaining monitor is the user's choice and does update it.
    env.display.emit('grab-op-begin', env.display, env.display, w, 1);
    w.frame = { x: 2100, y: 320, width: 700, height: 426 };
    env.display.emit('grab-op-end', env.display, env.display, w, 1);
    env.runTimers();
    saved = readState(env).windows[0];
    assert.deepEqual(saved.monitor, { index: 0, x: 1920, y: 0, w: 1920, h: 1080 });
});

// Restore at window-created (before the first map), with the map as a correction only.
test('a window created unmapped with a saved entry is moved at window-created, before its map', () => {
    const env = install();
    seedState(env, [seedEntry()]);
    load(env);
    const w = env.makeWindow({ frame: { x: 0, y: 0, width: 400, height: 300 } });
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.moves, [[100, 50, 800, 600]]); // no map event has been sent yet
    assert.equal(env.errors, undefined);
});

test('a map with the window already in place makes no second move', () => {
    const env = install();
    seedState(env, [seedEntry()]);
    load(env);
    const w = env.makeWindow({ frame: { x: 0, y: 0, width: 400, height: 300 } });
    env.display.emit('window-created', env.display, w);
    env.mapWindow(w);
    assert.deepEqual(w.moves, [[100, 50, 800, 600]]);
    assert.equal(env.errors, undefined);
});

test('a window that differs from the saved place at map is moved once, and later maps do nothing', () => {
    const env = install();
    seedState(env, [seedEntry()]);
    load(env);
    const w = env.makeWindow({ frame: { x: 0, y: 0, width: 400, height: 300 } });
    env.display.emit('window-created', env.display, w);
    w.frame = { x: 640, y: 360, width: 800, height: 600 }; // Muffin placed it after the early move
    env.mapWindow(w);
    assert.deepEqual(w.moves, [[100, 50, 800, 600], [100, 50, 800, 600]]);
    assert.deepEqual(w.frame, { x: 100, y: 50, width: 800, height: 600 });

    w.frame = { x: 20, y: 30, width: 700, height: 500 }; // later the window is shown again (unminimized, say)
    env.mapWindow(w);
    assert.equal(w.moves.length, 2);
    assert.deepEqual(w.frame, { x: 20, y: 30, width: 700, height: 500 });
});

test('workspace and maximize are applied at window-created, and the map neither repeats them nor un-maximizes', () => {
    const env = install();
    seedState(env, [seedEntry({ workspace: 2, maximized: true })]);
    load(env);
    const w = env.makeWindow({});
    env.display.emit('window-created', env.display, w);
    assert.equal(w.workspace, 2);
    assert.equal(w.maximized, 3);
    assert.deepEqual(w.ops, ['maximize']);
    const moved = w.moves.length;
    w.frame = { x: 0, y: 0, width: 1920, height: 1080 }; // the maximized frame is not the saved rect
    env.mapWindow(w);
    assert.deepEqual(w.ops, ['maximize']);
    assert.equal(w.moves.length, moved);
});

test('with remember-size off the map correction restores the position and leaves the size alone', () => {
    const env = install({ settings: { 'remember-size': false } });
    seedState(env, [seedEntry()]);
    load(env);
    const w = env.makeWindow({ frame: { x: 0, y: 0, width: 1000, height: 700 } });
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.moves, [[100, 50, 1000, 700]]);
    w.frame = { x: 640, y: 360, width: 1200, height: 800 }; // Muffin placed and sized it
    env.mapWindow(w);
    assert.deepEqual(w.moves[1], [100, 50, 1200, 800]);
    assert.equal(w.moves.length, 2);
});

test('with remember-position off the map correction restores the size and leaves the position alone', () => {
    const env = install({ settings: { 'remember-position': false } });
    seedState(env, [seedEntry()]);
    load(env);
    const w = env.makeWindow({ frame: { x: 0, y: 0, width: 400, height: 300 } });
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.moves, [[0, 0, 800, 600]]);
    w.frame = { x: 640, y: 360, width: 400, height: 300 }; // Muffin placed it
    env.mapWindow(w);
    assert.deepEqual(w.moves[1], [640, 360, 800, 600]);
    assert.equal(w.moves.length, 2);
});

test('a window with no saved entry, a dialog and an excluded app are not moved at window-created or at map', () => {
    const env = install({ settings: { 'excluded-apps': [{ wmclass: 'firefox' }] } });
    seedState(env, [seedEntry(), seedEntry({ id: 'g', key: 'gedit|gedit', wmClass: 'Gedit', instance: 'gedit' })]);
    load(env);
    const excluded = env.makeWindow({});
    const dialog = env.makeWindow({ wmClass: 'Gedit', instance: 'gedit', type: 1 });
    const unknown = env.makeWindow({ wmClass: 'Xed', instance: 'xed' });
    for (const w of [excluded, dialog, unknown]) {
        env.display.emit('window-created', env.display, w);
        assert.deepEqual(w.moves, []);
        assert.deepEqual(w.ops, []);
        env.mapWindow(w);
        assert.deepEqual(w.moves, []);
        assert.deepEqual(w.ops, []);
    }
    assert.equal(env.errors, undefined);
});

test('a window restored at window-created is not captured until it is mapped', () => {
    const env = install();
    seedState(env, [seedEntry()]);
    load(env);
    const w = env.makeWindow({ frame: { x: 0, y: 0, width: 400, height: 300 } });
    env.display.emit('window-created', env.display, w);
    w.frame = { x: 640, y: 360, width: 800, height: 600 }; // Muffin's placement, seen as a position change
    w.emit('position-changed', w);
    env.runTimers();
    assert.equal(readState(env).windows[0].lastSeen, 1); // the saved entry is untouched
    env.mapWindow(w);
    w.emit('position-changed', w); // now it is captured, at the corrected place
    env.runTimers();
    assert.deepEqual(readState(env).windows[0].rel, { x: 100, y: 50, w: 800, h: 600 });
    assert.equal(readState(env).windows[0].id, 'e1');
});

// The early restore.
const ON_SECOND = { index: 1, x: 1920, y: 0, w: 1920, h: 1080 };
const REL = { x: 100, y: 50, w: 800, h: 600 };

// Muffin puts a window that has no PPosition on the monitor under the pointer and maximizes it there, which loses the early move.
function muffinPutsItOnFirstMonitorMaximized(w) {
    w.monitor = 0;
    w.maximized = 3;
    w.frame = { x: 0, y: 0, width: 1920, height: 1080 };
}

test('a maximized entry on monitor 1 with no saved rect: a window Muffin put on monitor 0 is moved to monitor 1 and maximized', () => {
    const env = install({ monitors: TWO_MONITORS });
    seedState(env, [seedEntry({ maximized: true, monitor: ON_SECOND, rel: null })]);
    load(env);
    const w = env.makeWindow({});
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.ops, ['move_to_monitor:1', 'maximize']);
    muffinPutsItOnFirstMonitorMaximized(w);
    env.mapWindow(w);
    assert.equal(w.monitor, 1);
    assert.equal(w.maximized, 3);
    assert.deepEqual(w.ops, ['move_to_monitor:1', 'maximize', 'move_to_monitor:1']);
    assert.equal(env.errors, undefined);
});

test('a maximized entry on monitor 1 with a saved rect: a window Muffin put on monitor 0 is moved to monitor 1 and maximized', () => {
    const env = install({ monitors: TWO_MONITORS });
    seedState(env, [seedEntry({ maximized: true, monitor: ON_SECOND, rel: REL })]);
    load(env);
    const w = env.makeWindow({});
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.moves, [[2020, 50, 800, 600]]);
    assert.deepEqual(w.ops, ['maximize']);
    muffinPutsItOnFirstMonitorMaximized(w);
    env.mapWindow(w);
    assert.equal(w.monitor, 1);
    assert.equal(w.maximized, 3);
    assert.deepEqual(w.ops, ['maximize', 'move_to_monitor:1']);
    assert.equal(w.moves.length, 1); // a maximized window has no rect to correct
});

test('the map maximizes again when moving the window to its monitor un-maximized it', () => {
    const env = install({ monitors: TWO_MONITORS });
    seedState(env, [seedEntry({ maximized: true, monitor: ON_SECOND, rel: null })]);
    load(env);
    const w = env.makeWindow({});
    env.display.emit('window-created', env.display, w);
    muffinPutsItOnFirstMonitorMaximized(w);
    w.move_to_monitor = i => { w.monitor = i; w.maximized = 0; w.ops.push('move_to_monitor:' + i); };
    env.mapWindow(w);
    assert.equal(w.monitor, 1);
    assert.equal(w.maximized, 3);
    assert.deepEqual(w.ops, ['move_to_monitor:1', 'maximize', 'move_to_monitor:1', 'maximize']);
});

test('a maximized window that is already on its monitor at the map is left alone', () => {
    for (const rel of [null, REL]) {
        const env = install({ monitors: TWO_MONITORS });
        seedState(env, [seedEntry({ maximized: true, monitor: ON_SECOND, rel: rel })]);
        load(env);
        const w = env.makeWindow({});
        env.display.emit('window-created', env.display, w);
        const ops = w.ops.slice();
        const moves = w.moves.length;
        assert.equal(w.monitor, 1);
        env.mapWindow(w);
        assert.deepEqual(w.ops, ops);
        assert.equal(w.moves.length, moves);
    }
});

test('with remember-monitor off the map places the window by the monitor it is on at the map', () => {
    const env = install({ monitors: TWO_MONITORS, settings: { 'remember-monitor': false } });
    seedState(env, [seedEntry({ rel: REL })]); // saved on monitor 0
    load(env);
    const w = env.makeWindow({ monitor: 1, frame: { x: 2000, y: 100, width: 400, height: 300 } });
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.moves, [[2020, 50, 800, 600]]); // the client asked for monitor 1
    w.monitor = 0; // Muffin put it on monitor 0
    w.frame = { x: 300, y: 300, width: 800, height: 600 };
    env.mapWindow(w);
    assert.deepEqual(w.moves[1], [100, 50, 800, 600]);
    assert.equal(w.moves.length, 2);
});

test('with remember-monitor off a window that is still on its monitor at the map is not moved again', () => {
    const env = install({ monitors: TWO_MONITORS, settings: { 'remember-monitor': false } });
    seedState(env, [seedEntry({ rel: REL })]);
    load(env);
    const w = env.makeWindow({ monitor: 1, frame: { x: 2000, y: 100, width: 400, height: 300 } });
    env.display.emit('window-created', env.display, w);
    env.mapWindow(w);
    assert.deepEqual(w.moves, [[2020, 50, 800, 600]]);
});

// The monitor step at window-created: with remember-monitor on, the window goes to the saved monitor if it is not on it
// by then, whether or not a rect was applied.
test('with position and size off the window is still moved to its saved monitor at window-created, before its map', () => {
    const env = install({ monitors: TWO_MONITORS, settings: { 'remember-position': false, 'remember-size': false } });
    seedState(env, [seedEntry({ rel: REL })]); // saved on monitor 0, not maximized
    load(env);
    const w = env.makeWindow({ monitor: 1, frame: { x: 2000, y: 100, width: 400, height: 300 } });
    env.display.emit('window-created', env.display, w); // no map event has been sent yet
    assert.deepEqual(w.ops, ['move_to_monitor:0']);
    assert.equal(w.monitor, 0);
    assert.deepEqual(w.moves, []); // no rect is applied
    env.mapWindow(w);
    assert.deepEqual(w.ops, ['move_to_monitor:0']);
    assert.deepEqual(w.moves, []);
    assert.equal(env.errors, undefined);
});

test('with position and size off a window already on its saved monitor is not moved', () => {
    const env = install({ monitors: TWO_MONITORS, settings: { 'remember-position': false, 'remember-size': false } });
    seedState(env, [seedEntry({ rel: REL })]);
    load(env);
    const w = env.makeWindow({ monitor: 0 });
    open(env, w);
    assert.deepEqual(w.ops, []);
    assert.deepEqual(w.moves, []);
});

test('with remember-monitor off and position and size off nothing is moved', () => {
    const env = install({
        monitors: TWO_MONITORS, settings: { 'remember-monitor': false, 'remember-position': false, 'remember-size': false },
    });
    seedState(env, [seedEntry({ rel: REL })]);
    load(env);
    const w = env.makeWindow({ monitor: 1, frame: { x: 2000, y: 100, width: 400, height: 300 } });
    open(env, w);
    assert.deepEqual(w.ops, []);
    assert.deepEqual(w.moves, []);
    assert.equal(w.monitor, 1);
});

test('an entry with no rect is moved to its saved monitor even when it is not maximized', () => {
    const env = install({ monitors: TWO_MONITORS });
    seedState(env, [seedEntry({ monitor: ON_SECOND, rel: null })]);
    load(env);
    const w = env.makeWindow({ monitor: 0 });
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.ops, ['move_to_monitor:1']);
    assert.deepEqual(w.moves, []);
    assert.equal(w.maximized, 0);
});

test('a rect that puts the window on its saved monitor needs no second move', () => {
    const env = install({ monitors: TWO_MONITORS });
    seedState(env, [seedEntry({ rel: REL })]);
    load(env);
    const w = env.makeWindow({ monitor: 1, frame: { x: 2000, y: 100, width: 400, height: 300 } });
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.moves, [[100, 50, 800, 600]]); // the new frame is on monitor 0, and so is the window
    assert.deepEqual(w.ops, []);
    env.mapWindow(w);
    assert.deepEqual(w.ops, []);
});

test('a rect that leaves the window on another monitor than the saved one is followed by the move to that monitor', () => {
    const env = install({ monitors: TWO_MONITORS });
    seedState(env, [seedEntry({ rel: REL })]);
    load(env);
    const w = env.makeWindow({ monitor: 1, frame: { x: 2000, y: 100, width: 400, height: 300 } });
    // Muffin has not updated the monitor of this unmapped window after the move.
    w.move_resize_frame = (user, x, y, width, height) => {
        w.frame = { x: x, y: y, width: width, height: height };
        w.moves.push([x, y, width, height]);
    };
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.moves, [[100, 50, 800, 600]]);
    assert.deepEqual(w.ops, ['move_to_monitor:0']);
    assert.equal(w.monitor, 0);
    assert.equal(env.errors, undefined);
});

// Brave and Chrome give pop-up windows the role 'pop-up' with the class and instance of their normal windows.
test('a pop-up is not tracked, moved or saved, and claims no entry', () => {
    const env = install();
    const seeded = [
        seedEntry({ id: 'main', lastSeen: 2, role: 'browser', rel: { x: 10, y: 10, w: 800, h: 600 } }),
        seedEntry({ id: 'old-pop', lastSeen: 1, role: 'pop-up', rel: { x: 300, y: 200, w: 400, h: 300 } }),
    ];
    seedState(env, seeded);
    load(env);
    const popup = env.makeWindow({ role: 'pop-up', frame: { x: 0, y: 0, width: 300, height: 200 } });
    open(env, popup);
    assert.deepEqual(popup.moves, []);
    assert.deepEqual(popup.ops, []);
    assert.deepEqual(Object.keys(popup.handlers).filter(sig => popup.handlers[sig].length > 0), []); // nothing is watched
    popup.frame = { x: 40, y: 40, width: 500, height: 400 };
    env.display.emit('grab-op-end', env.display, popup);
    popup.emit('unmanaging', popup);
    popup.emit('unmanaged', popup);
    env.runTimers();
    assert.deepEqual(readState(env).windows, seeded); // no entry added, none updated
    assert.equal(env.errors, undefined);
});

test('a normal browser window still claims its entry, before or after a pop-up', () => {
    const env = install();
    seedState(env, [seedEntry({ id: 'main', role: 'browser', rel: { x: 10, y: 10, w: 800, h: 600 } })]);
    load(env);
    const popup = env.makeWindow({ role: 'pop-up', frame: { x: 0, y: 0, width: 300, height: 200 } });
    open(env, popup);
    const main = env.makeWindow({ role: 'browser', frame: { x: 0, y: 0, width: 300, height: 200 } });
    open(env, main);
    assert.deepEqual(popup.moves, []);
    assert.deepEqual(main.moves, [[10, 10, 800, 600]]);
    const second = env.makeWindow({ role: 'browser', frame: { x: 0, y: 0, width: 300, height: 200 } });
    open(env, second);
    assert.deepEqual(second.moves, []); // the entry is claimed by the first browser window
    main.frame = { x: 20, y: 30, width: 700, height: 500 };
    env.display.emit('grab-op-end', env.display, main);
    env.runTimers();
    const windows = readState(env).windows;
    assert.deepEqual(windows.map(e => e.id), ['main']); // main updated its own entry
    assert.deepEqual(windows[0].rel, { x: 20, y: 30, w: 700, h: 500 });
});

test('a pop-up that is already open when the extension starts does not take over a saved entry', () => {
    const env = install();
    seedState(env, [seedEntry({ id: 'main', role: 'browser', rel: { x: 10, y: 10, w: 800, h: 600 } })]);
    const popup = env.makeWindow({ role: 'pop-up', frame: { x: 0, y: 0, width: 300, height: 200 } });
    env.windows.push(popup);
    load(env);
    env.mapWindow(popup);
    assert.deepEqual(popup.moves, []);
    const main = env.makeWindow({ role: 'browser', frame: { x: 0, y: 0, width: 300, height: 200 } });
    open(env, main);
    assert.deepEqual(main.moves, [[10, 10, 800, 600]]); // not claimed by the pop-up
    assert.equal(env.errors, undefined);
});

test('xed and gnome-terminal windows, whose roles change on every launch, take the newest free entry', () => {
    const env = install();
    const rects = { new: { x: 300, y: 200, w: 900, h: 700 }, old: { x: 50, y: 60, w: 640, h: 480 } };
    seedState(env, [
        seedEntry({ id: 'xed-new', key: 'xed|xed', wmClass: 'Xed', instance: 'xed', role: 'xed-window-3-4-0-h', lastSeen: 4, rel: rects.new }),
        seedEntry({ id: 'xed-old', key: 'xed|xed', wmClass: 'Xed', instance: 'xed', role: 'xed-window-1-2-0-h', lastSeen: 3, rel: rects.old }),
        seedEntry({
            id: 'term-new', key: 'gnome-terminal|gnome-terminal-server', wmClass: 'Gnome-terminal', instance: 'gnome-terminal-server',
            role: 'gnome-terminal-window-bbbb', lastSeen: 6, rel: rects.new,
        }),
        seedEntry({
            id: 'term-old', key: 'gnome-terminal|gnome-terminal-server', wmClass: 'Gnome-terminal', instance: 'gnome-terminal-server',
            role: 'gnome-terminal-window-aaaa', lastSeen: 5, rel: rects.old,
        }),
    ]);
    load(env);
    const make = (wmClass, instance, role) => env.makeWindow({
        wmClass: wmClass, instance: instance, role: role, frame: { x: 0, y: 0, width: 400, height: 300 },
    });
    const xed1 = make('Xed', 'xed', 'xed-window-9-9-0-h');
    const xed2 = make('Xed', 'xed', 'xed-window-8-8-0-h');
    const term1 = make('Gnome-terminal', 'gnome-terminal-server', 'gnome-terminal-window-cccc');
    const term2 = make('Gnome-terminal', 'gnome-terminal-server', 'gnome-terminal-window-dddd');
    [xed1, xed2, term1, term2].forEach(w => open(env, w));
    assert.deepEqual(xed1.moves, [[300, 200, 900, 700]]);
    assert.deepEqual(xed2.moves, [[50, 60, 640, 480]]);
    assert.deepEqual(term1.moves, [[300, 200, 900, 700]]);
    assert.deepEqual(term2.moves, [[50, 60, 640, 480]]);
    assert.equal(env.errors, undefined);
});

test('forget-focused on a window that is created but not yet mapped leaves its map without a move', () => {
    const env = install();
    seedState(env, [seedEntry()]);
    const s = load(env);
    const w = env.makeWindow({ frame: { x: 0, y: 0, width: 400, height: 300 } });
    env.display.emit('window-created', env.display, w);
    assert.equal(w.moves.length, 1);
    w.frame = { x: 640, y: 360, width: 800, height: 600 }; // Muffin placed it
    env.display.focus_window = w;
    s.callbacks.forgetFocused();
    env.mapWindow(w);
    assert.equal(w.moves.length, 1);
    assert.deepEqual(w.frame, { x: 640, y: 360, width: 800, height: 600 });
});

test('forget-all on windows that are created but not yet mapped leaves their maps without a move', () => {
    const env = install({ monitors: TWO_MONITORS });
    seedState(env, [
        seedEntry(),
        seedEntry({ id: 'g', key: 'gedit|gedit', wmClass: 'Gedit', instance: 'gedit', maximized: true, monitor: ON_SECOND, rel: null }),
    ]);
    const s = load(env);
    const a = env.makeWindow({ frame: { x: 0, y: 0, width: 400, height: 300 } });
    const b = env.makeWindow({ wmClass: 'Gedit', instance: 'gedit' });
    env.display.emit('window-created', env.display, a);
    env.display.emit('window-created', env.display, b);
    a.frame = { x: 640, y: 360, width: 800, height: 600 };
    muffinPutsItOnFirstMonitorMaximized(b);
    s.callbacks.forgetAll();
    env.mapWindow(a);
    env.mapWindow(b);
    assert.equal(a.moves.length, 1);
    assert.deepEqual(b.ops, ['move_to_monitor:1', 'maximize']);
    assert.equal(b.monitor, 0);
});

test('a window class that contains a bar keeps its key after a reload', () => {
    const env = install();
    let s = load(env);
    const first = env.makeWindow({ wmClass: 'Foo|Bar', instance: 'Baz' });
    open(env, first);
    first.frame = { x: 300, y: 200, width: 900, height: 700 };
    env.display.emit('grab-op-end', env.display, first);
    env.runTimers();
    assert.equal(readState(env).windows[0].key, 'foo|bar|baz');
    s.ext.disable();

    s = load(env);
    const second = env.makeWindow({ wmClass: 'Foo|Bar', instance: 'Baz', frame: { x: 0, y: 0, width: 400, height: 300 } });
    open(env, second);
    assert.deepEqual(second.moves, [[300, 200, 900, 700]]);
    assert.equal(env.errors, undefined);
});

// Minimized state. Muffin sends notify::minimized when the flag changes, and 'shown' when a hidden window is shown again.
// A window restored minimized is hidden before its first show, so it never gets a 'map' (the restore of a minimized
// window is queued as a later). The mock's minimize() and unminimize() send those signals; env.runLaters() runs
// the Meta.later_add callbacks.

// The restore queues up to two laters: the minimize, in the RESIZE phase, and, when a restored place is waiting for the map,
// the correction of a window that is still hidden when the repaint pass ends, in the BEFORE_REDRAW phase. How many of one phase
// are pending; phase is a name of Meta.LaterType.
function pendingLaters(env, phase) {
    const type = globalThis.imports.gi.Meta.LaterType[phase];
    return [...env.laters.values()].filter(l => l.when === type).length;
}

test('a window minimized by the user is saved minimized, and normal again once restored', () => {
    const env = install();
    load(env);
    const w = env.makeWindow({});
    open(env, w);
    w.minimize(); // notify::minimized
    assert.equal(env.timers.size, 1); // the usual idle capture is waiting for the window to be still
    env.runTimers();
    assert.equal(readState(env).windows[0].minimized, true);
    w.unminimize(); // notify::minimized, then shown
    assert.equal(env.timers.size, 1); // notify::minimized scheduled the capture; the window is ready, so shown adds none
    env.runTimers();
    const windows = readState(env).windows;
    assert.equal(windows.length, 1);
    assert.equal(windows[0].minimized, false);
    assert.equal(env.errors, undefined);
});

test('a window closed while minimized is saved minimized', () => {
    const env = install();
    load(env);
    const w = env.makeWindow({});
    open(env, w);
    w.minimize();
    w.emit('unmanaging', w); // Muffin has not cleared the flag when it starts to tear the window down
    w.emit('unmanaged', w);
    const windows = readState(env).windows;
    assert.equal(windows.length, 1);
    assert.equal(windows[0].minimized, true);
    assert.equal(env.timers.size, 0);
    assert.equal(env.errors, undefined);
});

test('a saved minimized window is minimized after its rect is applied, and is never shown or mapped', () => {
    const env = install();
    const Meta = globalThis.imports.gi.Meta; // the mock that install() has just set up
    seedState(env, [seedEntry({ minimized: true })]);
    load(env);
    const w = env.makeWindow({ frame: { x: 0, y: 0, width: 400, height: 300 } });
    env.display.emit('window-created', env.display, w);
    // The rect is applied at window-created. The minimize waits for a RESIZE later, which runs before the window's first
    // showing decision: a minimize made right here would be undone by Muffin's MapRequest handler (x11/events.c:1427-1429).
    // The rect is a restored place that waits for the map, which this window will not get: a BEFORE_REDRAW later is queued
    // to check it while the window is hidden.
    assert.deepEqual(w.moves, [[100, 50, 800, 600]]);
    assert.equal(w.minimized, false);
    assert.deepEqual([...env.laters.values()].map(l => l.when), [Meta.LaterType.RESIZE, Meta.LaterType.BEFORE_REDRAW]);
    env.runLaters();
    assert.equal(w.minimized, true);
    assert.deepEqual(w.ops, ['minimize']);
    assert.deepEqual(w.moves, [[100, 50, 800, 600]]); // not moved again
    assert.equal(env.laters.size, 0); // it ran once
    // No 'map' and no 'shown' has been sent: the window is still waiting for its first show, so nothing is captured.
    env.runTimers();
    assert.equal(readState(env).windows[0].lastSeen, 1);
    assert.equal(env.errors, undefined);
});

test('with remember-minimized off a saved minimized window opens normal', () => {
    for (const on of [true, false]) {
        const env = install({ settings: { 'remember-minimized': on } });
        seedState(env, [seedEntry({ minimized: true })]);
        load(env);
        const w = env.makeWindow({ frame: { x: 0, y: 0, width: 400, height: 300 } });
        env.display.emit('window-created', env.display, w);
        assert.equal(pendingLaters(env, 'RESIZE'), on ? 1 : 0, 'remember-minimized ' + on); // with the switch off no minimize is even queued
        env.runLaters();
        assert.equal(w.minimized, on, 'remember-minimized ' + on); // the switch alone decides
        assert.deepEqual(w.moves, [[100, 50, 800, 600]]); // the rect is restored either way
        assert.equal(env.errors, undefined);
    }
});

test("forget-focused before the restore's minimize runs cancels it", () => {
    const env = install();
    seedState(env, [seedEntry({ minimized: true })]);
    const s = load(env);
    const w = env.makeWindow({});
    env.display.emit('window-created', env.display, w);
    assert.equal(pendingLaters(env, 'RESIZE'), 1); // the minimize is waiting
    env.display.focus_window = w;
    s.callbacks.forgetFocused();
    assert.equal(env.laters.size, 0); // taken back, with the correction queued beside it, not merely ignored when it runs
    env.runLaters();
    assert.equal(w.minimized, false);
    env.runTimers();
    assert.equal(readState(env).windows.length, 0); // and the entry is gone
    assert.equal(env.errors, undefined);
});

test("forget-all before the restore's minimize runs cancels it", () => {
    const env = install();
    seedState(env, [seedEntry({ minimized: true })]);
    const s = load(env);
    const w = env.makeWindow({});
    env.display.emit('window-created', env.display, w);
    assert.equal(pendingLaters(env, 'RESIZE'), 1);
    s.callbacks.forgetAll();
    assert.equal(env.laters.size, 0);
    env.runLaters();
    assert.equal(w.minimized, false);
    env.runTimers();
    assert.equal(readState(env).windows.length, 0);
    assert.equal(env.errors, undefined);
});

test('disable cancels a pending minimize and leaves no later behind', () => {
    const env = install();
    seedState(env, [seedEntry({ minimized: true })]);
    const s = load(env);
    const w = env.makeWindow({});
    env.display.emit('window-created', env.display, w);
    assert.equal(pendingLaters(env, 'RESIZE'), 1);
    s.ext.disable();
    assert.equal(env.laters.size, 0);
    assert.equal(env.timers.size, 0);
    env.runLaters();
    assert.equal(w.minimized, false);
    assert.equal(env.errors, undefined);
});

test('a minimize that has already run is not cancelled again by a forget or by disable', () => {
    const env = install();
    seedState(env, [seedEntry({ minimized: true })]);
    const s = load(env);
    const w = env.makeWindow({});
    env.display.emit('window-created', env.display, w);
    env.runLaters();
    assert.equal(w.minimized, true);
    env.display.focus_window = w;
    s.callbacks.forgetFocused();
    s.ext.disable();
    assert.deepEqual(env.removedLaters, []); // its id was cleared when it ran
    assert.equal(env.errors, undefined);
});

test('closing a window before its minimize runs takes the minimize back', () => {
    const env = install();
    seedState(env, [seedEntry({ minimized: true })]);
    load(env);
    const w = env.makeWindow({});
    env.display.emit('window-created', env.display, w);
    assert.equal(pendingLaters(env, 'RESIZE'), 1);
    w.emit('unmanaging', w);
    w.emit('unmanaged', w);
    assert.equal(env.laters.size, 0);
    env.runLaters();
    assert.deepEqual(w.ops, []);
    assert.equal(env.errors, undefined);
});

test('turning the setting off before the minimize runs stops it', () => {
    for (const key of ['remember-minimized', 'enabled']) {
        const env = install();
        seedState(env, [seedEntry({ minimized: true })]);
        load(env);
        const w = env.makeWindow({});
        env.display.emit('window-created', env.display, w);
        assert.equal(pendingLaters(env, 'RESIZE'), 1, key);
        env.changeSetting(key, false);
        env.runLaters();
        assert.equal(w.minimized, false, key);
        assert.equal(env.errors, undefined, key);
    }
});

test('a window restored from a start-minimized state is captured normal', () => {
    const env = install();
    seedState(env, [seedEntry({ minimized: true })]);
    load(env);
    const w = env.makeWindow({ frame: { x: 0, y: 0, width: 400, height: 300 } });
    env.display.emit('window-created', env.display, w);
    w.frame = { x: 640, y: 360, width: 800, height: 600 }; // Muffin placed it while it was hidden
    env.runLaters(); // the repaint pass: the minimize, and the correction of the hidden window
    assert.equal(w.minimized, true); // hidden since before its first show: no map, so it is not ready
    assert.deepEqual(w.moves, [[100, 50, 800, 600], [100, 50, 800, 600]]); // the move at window-created, then back on the saved rect while hidden
    w.unminimize(); // the user restores it: notify::minimized, then shown
    env.runTimers();
    assert.equal(w.moves.length, 2); // its first show moves nothing
    const windows = readState(env).windows;
    assert.equal(windows.length, 1);
    assert.equal(windows[0].id, 'e1'); // its own entry, updated
    assert.equal(windows[0].minimized, false); // the saved minimized: true would bring it back minimized next time
    assert.deepEqual(windows[0].rel, { x: 100, y: 50, w: 800, h: 600 }); // and the saved rect stays
    assert.equal(env.errors, undefined);
});

test('a second show of a ready window schedules no capture and leaves its entry unchanged', () => {
    const env = install();
    const seeded = seedEntry();
    seedState(env, [seeded]);
    load(env);
    const w = env.makeWindow({});
    open(env, w); // created and mapped: ready, bound to its entry, and nothing captured yet
    assert.equal(env.timers.size, 0);
    w.emit('shown', w); // Muffin sends 'shown' each time a window that was hidden is shown again, after a workspace switch for one ...
    w.emit('shown', w); // ... so a window that is ready gets it again and again
    assert.equal(env.timers.size, 0); // only the show that makes a window ready captures
    env.runTimers();
    assert.deepEqual(readState(env).windows, [seeded]); // lastSeen is still 1: no capture ran
    assert.equal(env.errors, undefined);
});

// A window that is ready is shown again at every workspace switch. That must not hold its place: only the show that makes a
// window ready can leave its place unchecked, and a restored window that was mapped still has its plan (target) after the map.
test('a re-show of a ready window does not freeze its place, so a later move is saved', () => {
    const env = install();
    seedState(env, [seedEntry()]); // saved rect 100,50 800x600
    load(env);
    const w = env.makeWindow({ frame: { x: 0, y: 0, width: 400, height: 300 } });
    open(env, w); // restored, so it has a plan, and mapped: ready
    assert.deepEqual(w.moves, [[100, 50, 800, 600]]);
    w.emit('shown', w); // shown again, after a workspace switch say: it was ready already
    w.frame = { x: 300, y: 200, width: 900, height: 700 }; // the user moves it
    w.emit('position-changed', w);
    env.runTimers();
    assert.deepEqual(readState(env).windows[0].rel, { x: 300, y: 200, w: 900, h: 700 });
    assert.equal(env.errors, undefined);
});

// The correction belongs to the show that makes a window ready only. A window that is ready is shown again at every workspace
// switch and keeps its restored place in the record (target), so a correction then would snap a window the user moved back.
test('a re-show of a ready window leaves it where the user put it', () => {
    const env = install();
    seedState(env, [seedEntry()]); // saved rect 100,50 800x600
    load(env);
    const w = env.makeWindow({ frame: { x: 0, y: 0, width: 400, height: 300 } });
    open(env, w); // restored, so it has a plan, and mapped: ready
    w.frame = { x: 300, y: 200, width: 900, height: 700 }; // the user moves it
    w.emit('shown', w); // shown again, after a workspace switch say
    assert.deepEqual(w.moves, [[100, 50, 800, 600]]); // not moved back: only the move at window-created
    assert.deepEqual(w.frame, { x: 300, y: 200, width: 900, height: 700 });
    assert.equal(env.errors, undefined);
});

// A window restored to another workspace is first shown when the user switches to it, and that show has no map event
// (compositor/meta-window-actor.c:863-864). 'shown' is then the only signal, so it must make the window ready and capture
// it. The window was put on its saved place while it was still hidden, by the correction queued at window-created, and the
// capture keeps the saved rect.
test('the show that makes a window ready captures it, with no map and no notify::minimized before it', () => {
    const env = install();
    seedState(env, [seedEntry({ workspace: 1 })]);
    load(env);
    const w = env.makeWindow({ frame: { x: 0, y: 0, width: 400, height: 300 } });
    env.display.emit('window-created', env.display, w);
    assert.equal(w.workspace, 1); // placed on its saved workspace, and hidden until the user goes there
    w.frame = { x: 640, y: 360, width: 800, height: 600 }; // Muffin placed it meanwhile
    env.runLaters(); // the repaint pass puts it back on the saved rect while it is hidden
    w.emit('shown', w); // the user switches to that workspace
    assert.equal(env.timers.size, 1); // the show that makes the window ready schedules its capture
    env.runTimers();
    assert.deepEqual(w.moves, [[100, 50, 800, 600], [100, 50, 800, 600]]); // the move at window-created, then the correction while hidden: the show moves nothing
    const windows = readState(env).windows;
    assert.equal(windows.length, 1);
    assert.equal(windows[0].id, 'e1');
    assert.ok(windows[0].lastSeen > 1, 'captured'); // the seeded entry has lastSeen 1
    assert.deepEqual(windows[0].rel, { x: 100, y: 50, w: 800, h: 600 }); // the saved rect, not the one Muffin gave it
    assert.equal(env.errors, undefined);
});

// A window whose first show had no map was put on its saved place while it was hidden. Until a drag or resize (grab-op-end)
// the captures keep the saved monitor and rect: what the application or Muffin changes after that is not the user's
// choice. A drag or resize saves the new place and ends that.
test('after a show with no map, a drag or resize saves the new place, and later captures follow the window again', () => {
    const env = install({ monitors: TWO_MONITORS });
    seedState(env, [seedEntry({ minimized: true })]); // saved on monitor 0, rect 100,50 800x600
    load(env);
    const w = env.makeWindow({ frame: { x: 0, y: 0, width: 400, height: 300 } });
    env.display.emit('window-created', env.display, w);
    w.monitor = 1; // Muffin put it on the other monitor while it was hidden
    w.frame = { x: 2300, y: 200, width: 700, height: 500 };
    env.runLaters(); // the repaint pass: the minimize, and the window is put back on its saved place while it is hidden
    assert.equal(w.monitor, 0);
    w.unminimize(); // the user restores it: its first show has no map
    env.runTimers();
    let saved = readState(env).windows[0];
    assert.equal(saved.minimized, false); // captured ...
    assert.deepEqual(saved.monitor, { index: 0, x: 0, y: 0, w: 1920, h: 1080 }); // ... but the place is the saved one
    assert.deepEqual(saved.rel, { x: 100, y: 50, w: 800, h: 600 });
    assert.equal(w.monitor, 0); // and the show left it on its saved monitor

    w.monitor = 1; // the application moves it again after the show ...
    w.frame = { x: 2300, y: 200, width: 700, height: 500 };
    w.emit('position-changed', w);
    env.runTimers();
    saved = readState(env).windows[0];
    assert.deepEqual(saved.monitor, { index: 0, x: 0, y: 0, w: 1920, h: 1080 }); // ... and the user did not choose that
    assert.deepEqual(saved.rel, { x: 100, y: 50, w: 800, h: 600 });

    env.display.emit('grab-op-begin', env.display, env.display, w, 1);
    w.frame = { x: 2500, y: 300, width: 650, height: 450 }; // the user drags it (it is on monitor 1 again)
    env.display.emit('grab-op-end', env.display, env.display, w, 1);
    env.runTimers();
    saved = readState(env).windows[0];
    assert.deepEqual(saved.monitor, { index: 1, x: 1920, y: 0, w: 1920, h: 1080 }); // the new place is saved
    assert.deepEqual(saved.rel, { x: 580, y: 300, w: 650, h: 450 });

    w.frame = { x: 2600, y: 350, width: 650, height: 450 }; // an ordinary move after that is captured again
    w.emit('position-changed', w);
    env.runTimers();
    saved = readState(env).windows[0];
    assert.deepEqual(saved.rel, { x: 680, y: 350, w: 650, h: 450 });
    assert.equal(env.errors, undefined);
});

// The other side of that: a window with no restored place waiting for a map has nothing to protect, so the capture at its
// first show with no map saves the place it has, and the captures after it follow the window as for any other.
test('a window first shown with no restored place saves its place', () => {
    const env = install({ monitors: TWO_MONITORS, settings: { 'remember-position': false, 'remember-size': false } });
    seedState(env, [seedEntry({ workspace: 1 })]); // saved on monitor 0, rect 100,50 800x600, workspace 1
    load(env);
    const w = env.makeWindow({ frame: { x: 0, y: 0, width: 400, height: 300 } });
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.moves, []); // position and size are not restored, so no rect waits for a map to check
    assert.deepEqual(w.ops, []);
    w.monitor = 1; // Muffin put it on the other monitor, at another place
    w.frame = { x: 2300, y: 200, width: 700, height: 500 };
    w.emit('shown', w); // first shown at a workspace switch: no map
    env.runTimers();
    let saved = readState(env).windows[0];
    assert.ok(saved.lastSeen > 1, 'captured'); // the seeded entry has lastSeen 1
    assert.deepEqual(saved.monitor, { index: 1, x: 1920, y: 0, w: 1920, h: 1080 }); // the place it has, not the seeded one
    assert.deepEqual(saved.rel, { x: 380, y: 200, w: 700, h: 500 });
    w.frame = { x: 2400, y: 250, width: 700, height: 500 };
    w.emit('position-changed', w);
    env.runTimers();
    saved = readState(env).windows[0];
    assert.deepEqual(saved.rel, { x: 480, y: 250, w: 700, h: 500 });
    assert.equal(env.errors, undefined);
});

// A window restored maximized has only targetMonitor left of its plan (the restore clears target and lateEntry for it). Muffin
// may put it on the monitor under the pointer; the map would move it back to its saved monitor, and with no map the correction
// queued at window-created does, while the window is hidden. The capture after the first show keeps the saved monitor.
test('a maximized window first shown with no map keeps the monitor it was saved on', () => {
    const env = install({ monitors: TWO_MONITORS });
    seedState(env, [seedEntry({ maximized: true, monitor: ON_SECOND, rel: REL })]);
    load(env);
    const w = env.makeWindow({});
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.moves, [[2020, 50, 800, 600]]); // restored onto its saved monitor 1 ...
    assert.deepEqual(w.ops, ['maximize']); // ... and maximized there
    muffinPutsItOnFirstMonitorMaximized(w); // but Muffin put it on monitor 0, maximized, before it was ever shown
    env.runLaters(); // the repaint pass sends it back to its saved monitor while it is hidden
    assert.deepEqual(w.ops, ['maximize', 'move_to_monitor:1']);
    w.emit('shown', w); // first shown at a workspace switch: no map, and the show moves nothing
    env.runTimers();
    assert.equal(w.moves.length, 1); // a maximized window has no rect to correct: only the move at window-created
    assert.deepEqual(w.ops, ['maximize', 'move_to_monitor:1']);
    const saved = readState(env).windows[0];
    assert.ok(saved.lastSeen > 1, 'captured'); // the seeded entry has lastSeen 1
    assert.equal(saved.maximized, true);
    assert.deepEqual(saved.monitor, ON_SECOND); // the saved monitor, not the one Muffin chose
    assert.deepEqual(saved.rel, REL);
    muffinPutsItOnFirstMonitorMaximized(w); // the application or Muffin puts it on monitor 0 again after the show ...
    w.emit('position-changed', w);
    env.runTimers();
    assert.deepEqual(readState(env).windows[0].monitor, ON_SECOND); // ... which the user did not choose: the saved monitor stays
    assert.equal(env.errors, undefined);
});

// A design choice (manual-test item 23), made while the window is hidden: a window whose restored place is waiting for a map it
// may never get (it appears after a workspace switch, or was restored minimized) is put on that place by a BEFORE_REDRAW later
// queued at window-created. Muffin places a hidden window in its CALC_SHOWING pass, which runs before that phase in the same
// repaint pass, so the correction comes after Muffin's placement and before any show: no jump to see, and nothing moves inside
// the show. Windows that get a map are corrected at the map, as before.
test('a window restored to another workspace is placed at its saved rect and monitor after the repaint pass, before any show', () => {
    const env = install({ monitors: TWO_MONITORS });
    seedState(env, [seedEntry({ workspace: 1, monitor: ON_SECOND, rel: REL })]); // saved on monitor 1, rect 100,50 800x600 there
    load(env);
    const w = env.makeWindow({ frame: { x: 0, y: 0, width: 400, height: 300 } });
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.moves, [[2020, 50, 800, 600]]); // placed at window-created ...
    assert.equal(w.workspace, 1); // ... and sent to its workspace, which is not in view: it stays hidden
    w.monitor = 0; // Muffin put it on the other monitor, at another place, while hiding it
    w.frame = { x: 300, y: 200, width: 700, height: 500 };
    env.runLaters(); // the repaint pass: BEFORE_REDRAW comes after Muffin's placement
    assert.deepEqual(w.moves, [[2020, 50, 800, 600], [2020, 50, 800, 600]]); // back on the saved rect ...
    assert.equal(w.monitor, 1); // ... and on the saved monitor, before any show
    w.emit('shown', w); // the user switches to that workspace
    assert.equal(w.moves.length, 2); // the show moves nothing
    env.runTimers(); // the idle capture
    const saved = readState(env).windows[0];
    assert.ok(saved.lastSeen > 1, 'captured'); // the seeded entry has lastSeen 1
    assert.deepEqual(saved.monitor, ON_SECOND); // the saved place is unchanged
    assert.deepEqual(saved.rel, REL);
    assert.equal(env.errors, undefined);
});

test('a window restored minimized is corrected while hidden, and its first show moves nothing', () => {
    const env = install();
    seedState(env, [seedEntry({ minimized: true })]); // saved rect 100,50 800x600
    load(env);
    const w = env.makeWindow({ frame: { x: 0, y: 0, width: 400, height: 300 } });
    env.display.emit('window-created', env.display, w);
    w.frame = { x: 640, y: 360, width: 700, height: 500 }; // Muffin placed it while hiding it
    env.runLaters(); // the repaint pass: the minimize, then the correction
    assert.equal(w.minimized, true);
    assert.equal(w.showing, false); // still hidden ...
    assert.deepEqual(w.frame, { x: 100, y: 50, width: 800, height: 600 }); // ... and already back on the saved rect
    assert.deepEqual(w.moves, [[100, 50, 800, 600], [100, 50, 800, 600]]);
    w.frame = { x: 500, y: 400, width: 800, height: 600 }; // the application moves it again while it is hidden
    w.unminimize(); // the user restores it: its first show
    assert.deepEqual(w.moves, [[100, 50, 800, 600], [100, 50, 800, 600]]); // the show moves nothing, not even then
    assert.deepEqual(w.frame, { x: 500, y: 400, width: 800, height: 600 });
    env.runTimers();
    assert.deepEqual(readState(env).windows[0].rel, { x: 100, y: 50, w: 800, h: 600 }); // and the capture keeps the saved rect
    assert.equal(env.errors, undefined);
});

test('a maximized window restored to another workspace is sent to its saved monitor and maximized in the repaint pass, before any show', () => {
    const env = install({ monitors: TWO_MONITORS });
    seedState(env, [seedEntry({ maximized: true, monitor: ON_SECOND, rel: null })]); // no rect: only targetMonitor is left of the plan
    load(env);
    const w = env.makeWindow({});
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.ops, ['move_to_monitor:1', 'maximize']); // sent to its saved monitor 1 and maximized there
    muffinPutsItOnFirstMonitorMaximized(w); // but Muffin put it on monitor 0, maximized, before it was ever shown
    w.move_to_monitor = i => { w.monitor = i; w.maximized = 0; w.ops.push('move_to_monitor:' + i); }; // and a move un-maximizes it
    env.runLaters(); // the repaint pass, before any show
    assert.equal(w.monitor, 1);
    assert.equal(w.maximized, 3);
    assert.deepEqual(w.ops, ['move_to_monitor:1', 'maximize', 'move_to_monitor:1', 'maximize']);
    w.emit('shown', w); // its first show, with no map
    assert.deepEqual(w.ops, ['move_to_monitor:1', 'maximize', 'move_to_monitor:1', 'maximize']); // moves nothing
    assert.equal(env.errors, undefined);
});

test('a window shown with no map and no restored place is not moved at the show', () => {
    const env = install({ monitors: TWO_MONITORS, settings: { 'remember-position': false, 'remember-size': false } });
    seedState(env, [seedEntry()]); // saved on monitor 0, rect 100,50 800x600
    load(env);
    const w = env.makeWindow({ frame: { x: 0, y: 0, width: 400, height: 300 } });
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.moves, []); // position and size are not restored, so no place waits to be checked
    assert.deepEqual(w.ops, []);
    assert.equal(env.laters.size, 0); // and no correction is queued
    w.monitor = 1; // wherever the client or Muffin put it
    w.frame = { x: 2300, y: 200, width: 700, height: 500 };
    w.emit('shown', w); // its first show, with no map
    assert.deepEqual(w.moves, []); // there is nothing to put it back to: it stays where it is
    assert.deepEqual(w.ops, []);
    assert.deepEqual(w.frame, { x: 2300, y: 200, width: 700, height: 500 });
    assert.equal(w.monitor, 1);
    assert.equal(env.errors, undefined);
});

// The correction is for a window that is still hidden when the repaint pass ends. A window that maps is shown by the
// CALC_SHOWING phase, which comes first: it is ready by the time the later runs, and the map has corrected it.
test('a window that maps normally is not corrected by the later', () => {
    const env = install();
    seedState(env, [seedEntry()]); // saved rect 100,50 800x600
    const s = load(env);
    const w = env.makeWindow({ frame: { x: 0, y: 0, width: 400, height: 300 } });
    env.display.emit('window-created', env.display, w);
    assert.equal(pendingLaters(env, 'BEFORE_REDRAW'), 1); // the correction is waiting
    w.frame = { x: 640, y: 360, width: 800, height: 600 }; // Muffin placed it elsewhere
    env.mapWindow(w); // CALC_SHOWING shows it: the map corrects it, and it is ready
    assert.deepEqual(w.moves, [[100, 50, 800, 600], [100, 50, 800, 600]]);
    w.frame = { x: 300, y: 200, width: 900, height: 700 }; // then the application resizes it
    env.runLaters(); // BEFORE_REDRAW, later in the same pass: the window is ready, so the later leaves it alone
    assert.deepEqual(w.moves, [[100, 50, 800, 600], [100, 50, 800, 600]]); // not corrected again
    assert.deepEqual(w.frame, { x: 300, y: 200, width: 900, height: 700 });
    assert.equal(env.laters.size, 0); // and it has run
    s.ext.disable();
    assert.deepEqual(env.removedLaters, []); // its id was cleared when it ran, so there is nothing to take back
    assert.equal(env.errors, undefined);
});

test('forget-focused and forget-all before the correction runs cancel it', () => {
    for (const how of ['forgetFocused', 'forgetAll']) {
        const env = install();
        seedState(env, [seedEntry({ workspace: 1 })]);
        const s = load(env);
        const w = env.makeWindow({ frame: { x: 0, y: 0, width: 400, height: 300 } });
        env.display.emit('window-created', env.display, w);
        assert.equal(pendingLaters(env, 'BEFORE_REDRAW'), 1, how); // the correction is waiting ...
        assert.equal(pendingLaters(env, 'RESIZE'), 0, how); // ... and there is no minimize beside it
        w.frame = { x: 640, y: 360, width: 800, height: 600 }; // Muffin placed it elsewhere
        env.display.focus_window = w;
        s.callbacks[how]();
        assert.equal(env.laters.size, 0, how); // taken back, not merely ignored when it runs
        env.runLaters();
        assert.deepEqual(w.moves, [[100, 50, 800, 600]], how); // the window is not put back
        assert.deepEqual(w.frame, { x: 640, y: 360, width: 800, height: 600 }, how);
        assert.equal(env.errors, undefined, how);
    }
});

test('disable cancels a pending correction and leaves no later behind', () => {
    const env = install();
    seedState(env, [seedEntry({ workspace: 1 })]);
    const s = load(env);
    const w = env.makeWindow({ frame: { x: 0, y: 0, width: 400, height: 300 } });
    env.display.emit('window-created', env.display, w);
    assert.equal(pendingLaters(env, 'BEFORE_REDRAW'), 1);
    w.frame = { x: 640, y: 360, width: 800, height: 600 }; // Muffin placed it elsewhere
    s.ext.disable();
    assert.equal(env.laters.size, 0);
    env.runLaters();
    assert.deepEqual(w.moves, [[100, 50, 800, 600]]); // the window is not put back
    assert.equal(env.errors, undefined);
});

// The monitor a maximized window is sent to is chosen at window-created. If that monitor is unplugged before the correction
// runs, its index is past the list: the window must not be sent there, and not be maximized for it. The map uses the same code.
test('a targetMonitor past the current list is not used', () => {
    for (const how of ['later', 'map']) {
        const env = install({ monitors: TWO_MONITORS });
        seedState(env, [seedEntry({ maximized: true, monitor: ON_SECOND, rel: null })]);
        load(env);
        const w = env.makeWindow({});
        env.display.emit('window-created', env.display, w);
        assert.deepEqual(w.ops, ['move_to_monitor:1', 'maximize'], how); // sent to monitor 1 and maximized there
        w.monitor = 0; // Muffin put it on monitor 0, not maximized
        w.maximized = 0;
        env.setMonitors([MON0]); // monitor 1 is unplugged: index 1 is now past the list
        if (how === 'later') env.runLaters(); else env.mapWindow(w);
        assert.deepEqual(w.ops, ['move_to_monitor:1', 'maximize'], how); // nothing was sent to monitor 1, nothing maximized
        assert.equal(w.monitor, 0, how);
        assert.equal(w.maximized, 0, how);
        assert.equal(env.errors, undefined, how);
    }
});

test('a window that was never shown keeps its saved entry when it closes', () => {
    const env = install();
    const seeded = seedEntry({ minimized: true });
    seedState(env, [seeded]);
    load(env);
    const w = env.makeWindow({});
    env.display.emit('window-created', env.display, w);
    env.runLaters(); // restored minimized: hidden, so no map and no shown
    w.emit('unmanaging', w); // closed while minimized and never shown: not ready, so not captured
    w.emit('unmanaged', w);
    assert.deepEqual(readState(env).windows, [seeded]);
    assert.equal(env.errors, undefined);
});

test('an excluded app is not minimized on restore', () => {
    const env = install({ settings: { 'excluded-apps': [{ wmclass: 'firefox' }] } });
    seedState(env, [seedEntry({ minimized: true })]);
    load(env);
    const w = env.makeWindow({});
    env.display.emit('window-created', env.display, w);
    assert.equal(env.laters.size, 0);
    env.runLaters();
    assert.equal(w.minimized, false);
    assert.deepEqual(w.ops, []);
    assert.equal(env.errors, undefined);
});

test('a saved maximized and minimized window is maximized before it is minimized', () => {
    const env = install();
    seedState(env, [seedEntry({ maximized: true, minimized: true })]);
    load(env);
    const w = env.makeWindow({});
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.ops, ['maximize']); // the minimize waits for its later
    env.runLaters();
    assert.deepEqual(w.ops, ['maximize', 'minimize']);
    assert.equal(w.maximized, 3); // and it is maximized when the user restores it
    assert.equal(env.errors, undefined);
});

// Seen on X11 with xterm: Muffin dropped the maximize of a window that was minimized before its first show, while Chrome kept it.
// So the maximize is tried first, as before, and applied again when the user restores the window, if it was dropped.
test('a maximize that Muffin dropped on a window restored maximized and minimized is applied again when it is restored', () => {
    const env = install();
    seedState(env, [seedEntry({ maximized: true, minimized: true })]);
    load(env);
    const w = env.makeWindow({});
    env.display.emit('window-created', env.display, w);
    env.runLaters();
    w.maximized = 0; // dropped by the minimize
    w.unminimize();
    assert.equal(w.maximized, 3);
    assert.deepEqual(w.ops, ['maximize', 'minimize', 'unminimize', 'maximize']);
    assert.equal(env.errors, undefined);
});

test('a maximize that Muffin kept is not applied a second time when the window is restored', () => {
    const env = install();
    seedState(env, [seedEntry({ maximized: true, minimized: true })]);
    load(env);
    const w = env.makeWindow({});
    env.display.emit('window-created', env.display, w);
    env.runLaters();
    w.unminimize();
    assert.deepEqual(w.ops, ['maximize', 'minimize', 'unminimize']);
});

// The switch also decides whether a saved minimized state counts when a window picks its entry (lib/identity.js, pickEntry).
// Two saved windows of one app, the newer one minimized: with the switch on a new window takes the older, visible one.
test('a new window of an app with two saved windows takes the one that is not minimized, unless remember-minimized is off', () => {
    for (const on of [true, false]) {
        const env = install({ settings: { 'remember-minimized': on } });
        seedState(env, [
            seedEntry({ id: 'new', lastSeen: 2, minimized: true, rel: { x: 20, y: 0, w: 500, h: 400 } }),
            seedEntry({ id: 'old', lastSeen: 1, minimized: false, rel: { x: 10, y: 0, w: 500, h: 400 } }),
        ]);
        load(env);
        const w = env.makeWindow({});
        env.display.emit('window-created', env.display, w);
        env.runLaters();
        assert.deepEqual(w.moves, [on ? [10, 0, 500, 400] : [20, 0, 500, 400]], 'remember-minimized ' + on);
        assert.equal(w.minimized, false); // the entry it took is not minimized, or the switch is off
    }
});

test('a window that is already open claims the saved window that is not minimized, unless remember-minimized is off', () => {
    for (const on of [true, false]) {
        const env = install({ settings: { 'remember-minimized': on } });
        seedState(env, [
            seedEntry({ id: 'new', lastSeen: 2, minimized: true }),
            seedEntry({ id: 'old', lastSeen: 1, minimized: false }),
        ]);
        const w = env.makeWindow({});
        env.windows.push(w);
        load(env);
        w.emit('position-changed', w);
        env.runTimers();
        const updated = readState(env).windows.filter(e => e.lastSeen > 2).map(e => e.id); // the entry it claimed
        assert.deepEqual(updated, [on ? 'old' : 'new'], 'remember-minimized ' + on);
    }
});

// 'shown' is a Meta.Window signal that may not exist on every Muffin: a signal that cannot be connected must not stop the restore.
test('a signal that cannot be connected is logged and the window is still restored', () => {
    const env = install();
    seedState(env, [seedEntry()]);
    load(env);
    const w = env.makeWindow({ frame: { x: 0, y: 0, width: 400, height: 300 } });
    const connect = w.connect;
    w.connect = (sig, fn) => {
        if (sig === 'shown') throw new Error("No signal 'shown' on object 'Meta.Window'");
        return connect(sig, fn);
    };
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.moves, [[100, 50, 800, 600]]);
    assert.equal(env.errors.length, 1);
    assert.match(env.errors[0], /shown/);
});

// Back up and restore. The Import button of the settings page (backup_buttons.py) writes the window list of a backup to
// import-pending.json, next to state.json, and calls the importState callback. Cinnamon calls a callback with no try
// (ui/cinnamonDBus.js:359-363), so an error thrown there is the D-Bus error that tells the page to leave the settings as
// they are: every failure throws before any change, with the [window-memory] prefix of the extension's log lines, and
// the staging file is removed whatever happens.

function stagingPath(env) {
    return path.join(path.dirname(env.statePath), 'import-pending.json');
}

// Writes the staging file as the settings page does: content is a list of entries, written as a state of version 1, or
// the text to write.
function stageImport(env, content) {
    const text = typeof content === 'string' ? content : JSON.stringify({ version: 1, windows: content });
    fs.mkdirSync(path.dirname(stagingPath(env)), { recursive: true });
    fs.writeFileSync(stagingPath(env), text);
}

// An entry with every field a capture writes, which the loader keeps exactly as it is.
function fullEntry(over) {
    return seedEntry(Object.assign({ minimized: false }, over));
}

// What every failed import throws: a plain Error whose message starts with the prefix of the extension's log lines.
const REJECTED = { name: 'Error', message: /^\[window-memory\] / };

test('importState replaces the state with the windows of the staging file, writes it at once and removes the file', () => {
    const env = install();
    seedState(env, [seedEntry({ id: 'before' })]);
    const s = load(env);
    const imported = [
        fullEntry({ id: 'imp-firefox', lastSeen: 5, rel: { x: 300, y: 200, w: 640, h: 480 } }),
        fullEntry({ id: 'imp-gedit', key: 'gedit|gedit', wmClass: 'Gedit', instance: 'gedit', lastSeen: 6, maximized: true, minimized: true }),
    ];
    stageImport(env, imported);
    s.callbacks.importState();
    assert.deepEqual(readState(env).windows, imported); // written at once, not a second later
    assert.equal(fs.existsSync(stagingPath(env)), false);
    const w = env.makeWindow({ frame: { x: 0, y: 0, width: 400, height: 300 } });
    open(env, w);
    assert.deepEqual(w.moves, [[300, 200, 640, 480]]); // a window opened after the import is restored from the imported entry
    assert.equal(env.errors, undefined);
});

test('a save that is pending when the import arrives brings back no entry from before the import', () => {
    const env = install();
    seedState(env, [seedEntry({ id: 'before' })]);
    const s = load(env);
    const w = env.makeWindow({ wmClass: 'Gedit', instance: 'gedit' });
    open(env, w);
    env.display.emit('grab-op-end', env.display, w); // w is saved under a new entry, and the save waits for its second
    w.frame = { x: 10, y: 20, width: 300, height: 200 };
    w.emit('position-changed', w); // and a capture of w waits for it to be still
    assert.equal(env.timers.size, 2);
    stageImport(env, [fullEntry({ id: 'imp' })]);
    const rec = recordWrites();
    try {
        s.callbacks.importState();
        assert.equal(env.timers.size, 0); // neither is left to run later
        env.runTimers();
        assert.equal(rec.writes.length, 1); // the import's own write
        assert.deepEqual(JSON.parse(rec.writes[0]).windows.map(e => e.id), ['imp']);
    } finally {
        rec.stop();
    }
    assert.deepEqual(readState(env).windows.map(e => e.id), ['imp']);
    assert.equal(env.errors, undefined);
});

test('windows open during the import are bound to imported entries, the newest first and one entry each, and are not moved', () => {
    const env = install();
    const s = load(env);
    const first = env.makeWindow({});
    const second = env.makeWindow({});
    open(env, first);
    open(env, second);
    env.display.emit('grab-op-end', env.display, first); // first is saved under an entry of its own
    env.runTimers();
    env.display.focus_window = second;
    s.callbacks.forgetFocused(); // second is paused: not saved again until it is dragged
    stageImport(env, [
        fullEntry({ id: 'imp-old', lastSeen: 10, rel: { x: 10, y: 10, w: 500, h: 400 } }),
        fullEntry({ id: 'imp-new', lastSeen: 20, rel: { x: 20, y: 20, w: 500, h: 400 } }),
    ]);
    s.callbacks.importState();
    first.frame = { x: 300, y: 200, width: 900, height: 700 };
    first.emit('position-changed', first);
    second.frame = { x: 50, y: 60, width: 640, height: 480 };
    second.emit('position-changed', second); // the import ended the pause: an ordinary move is saved again
    env.runTimers();
    // first took imp-new, the newest imported entry of Firefox, and second took imp-old. No entry was added, and the one
    // first had before the import is gone.
    const rels = Object.fromEntries(readState(env).windows.map(e => [e.id, e.rel]));
    assert.deepEqual(rels, {
        'imp-old': { x: 50, y: 60, w: 640, h: 480 },
        'imp-new': { x: 300, y: 200, w: 900, h: 700 },
    });
    assert.deepEqual(first.moves, []);
    assert.deepEqual(second.moves, []);
    assert.equal(env.errors, undefined);
});

// A round trip: the backup holds the entries the open windows are bound to, with the same ids. Each window must not count
// the entry it held before the import as taken by another window.
test('importing a backup of the current state keeps each open window on its own entry', () => {
    const env = install();
    const entries = [
        fullEntry({ id: 'a', lastSeen: 2, rel: { x: 10, y: 10, w: 500, h: 400 } }),
        fullEntry({ id: 'b', lastSeen: 1, rel: { x: 20, y: 20, w: 500, h: 400 } }),
    ];
    seedState(env, entries);
    const first = env.makeWindow({});
    const second = env.makeWindow({});
    env.windows.push(first, second); // open at enable: first claims a, the newest, and second claims b
    const s = load(env);
    stageImport(env, entries);
    s.callbacks.importState();
    first.frame = { x: 300, y: 200, width: 900, height: 700 };
    first.emit('position-changed', first);
    second.frame = { x: 50, y: 60, width: 640, height: 480 };
    second.emit('position-changed', second);
    env.runTimers();
    const rels = Object.fromEntries(readState(env).windows.map(e => [e.id, e.rel]));
    assert.deepEqual(rels, { a: { x: 300, y: 200, w: 900, h: 700 }, b: { x: 50, y: 60, w: 640, h: 480 } });
    assert.equal(env.errors, undefined);
});

// A window that became ready at a show with no map keeps its saved place until it is dragged (placeUnchecked). That place
// came from the state before the import; after the import the window is bound as at enable, and saves the place it has.
test('a window that kept its saved place after a show with no map saves its own place after the import', () => {
    const env = install();
    seedState(env, [seedEntry({ workspace: 1 })]);
    const s = load(env);
    const w = env.makeWindow({ frame: { x: 0, y: 0, width: 400, height: 300 } });
    env.display.emit('window-created', env.display, w);
    env.runLaters(); // put on its saved place while it is hidden on workspace 1
    w.emit('shown', w); // first shown with no map: its captures keep that place until a drag
    env.runTimers();
    stageImport(env, [fullEntry({ id: 'imp', rel: { x: 300, y: 200, w: 640, h: 480 } })]);
    s.callbacks.importState();
    w.frame = { x: 40, y: 50, width: 700, height: 500 };
    w.emit('position-changed', w);
    env.runTimers();
    const windows = readState(env).windows;
    assert.deepEqual(windows.map(e => e.id), ['imp']);
    assert.deepEqual(windows[0].rel, { x: 40, y: 50, w: 700, h: 500 });
    assert.equal(env.errors, undefined);
});

test('a staging file that is not a valid state leaves the state as it was, and is removed', () => {
    const invalid = {
        'not JSON': '{broken',
        'wrong version': JSON.stringify({ version: 2, windows: [fullEntry({ id: 'imp' })] }),
    };
    for (const [what, text] of Object.entries(invalid)) {
        const env = install();
        seedState(env, [seedEntry({ id: 'before' })]);
        const s = load(env);
        const saved = fs.readFileSync(env.statePath, 'utf8');
        stageImport(env, text);
        assert.throws(() => s.callbacks.importState(),
            { name: 'Error', message: "[window-memory] import rejected: the backup's window list is not readable" }, what);
        assert.equal(fs.existsSync(stagingPath(env)), false, what);
        env.runTimers();
        assert.equal(fs.readFileSync(env.statePath, 'utf8'), saved, what);
        const w = env.makeWindow({ frame: { x: 0, y: 0, width: 400, height: 300 } });
        open(env, w);
        assert.deepEqual(w.moves, [[100, 50, 800, 600]], what); // still restored from the entry saved before
        assert.equal(env.errors, undefined, what);
    }
});

test('importState on a disabled extension throws, reads no file and changes nothing', () => {
    const env = install();
    seedState(env, [seedEntry({ id: 'before' })]);
    const s = load(env);
    s.ext.disable();
    const saved = fs.readFileSync(env.statePath, 'utf8');
    stageImport(env, [fullEntry({ id: 'imp' })]);
    const reads = recordReads();
    assert.throws(() => s.callbacks.importState(),
        { name: 'Error', message: '[window-memory] import rejected: Window Memory is not running' });
    assert.deepEqual(reads, []);
    assert.equal(fs.readFileSync(env.statePath, 'utf8'), saved);
    assert.equal(env.timers.size, 0);
    assert.equal(env.errors, undefined);
});

// Each failure throws with the prefix of the extension's log lines, and the message names its cause.
test('every failed import throws a message that names its cause, and leaves no staging file behind', () => {
    const failures = {
        'not JSON': [env => stageImport(env, '{broken'), /the backup's window list is not readable$/],
        'wrong version': [
            env => stageImport(env, JSON.stringify({ version: 2, windows: [] })),
            /the backup's window list is not readable$/,
        ],
        'missing file': [() => {}, /import-pending\.json does not exist$/],
        'unreadable file': [env => {
            stageImport(env, [fullEntry({ id: 'imp' })]);
            failReadsFrom('/import-pending.json');
        }, /import-pending\.json cannot be read: Permission denied$/],
        'extension not running': [(env, s) => {
            stageImport(env, [fullEntry({ id: 'imp' })]);
            s.ext.disable();
        }, /Window Memory is not running$/],
    };
    for (const [what, [prepare, cause]] of Object.entries(failures)) {
        const env = install();
        const s = load(env);
        prepare(env, s);
        let thrown = null;
        try {
            s.callbacks.importState();
        } catch (e) {
            thrown = e;
        }
        assert.ok(thrown instanceof Error, what + ': throws an Error');
        assert.match(thrown.message, REJECTED.message, what);
        assert.match(thrown.message, cause, what);
        assert.equal(fs.existsSync(stagingPath(env)), false, what);
    }
});

// A state file that is unreadable and cannot be moved aside switches saving off for the session (_loadState). A restore
// then would not be saved, so it is refused before anything changes.
test('importState refuses before any change when the state file cannot be saved', () => {
    const env = install();
    fs.mkdirSync(path.dirname(env.statePath), { recursive: true });
    fs.writeFileSync(env.statePath, '{broken');
    failMovesFrom('/state.json');
    const s = load(env);
    const w = env.makeWindow({});
    open(env, w);
    w.frame = { x: 10, y: 20, width: 300, height: 200 };
    w.emit('position-changed', w); // a capture waits for the window to be still
    const pending = env.timers.size;
    stageImport(env, [fullEntry({ id: 'imp-gedit', key: 'gedit|gedit', wmClass: 'Gedit', instance: 'gedit',
        rel: { x: 300, y: 200, w: 640, h: 480 } })]);
    const reads = recordReads();
    assert.throws(() => s.callbacks.importState(),
        { name: 'Error', message: '[window-memory] the state file cannot be saved, so the restore was refused' });
    assert.deepEqual(reads, []); // refused before the staging file is read
    assert.equal(fs.existsSync(stagingPath(env)), false);
    assert.equal(env.timers.size, pending); // the waiting capture was not dropped
    const gedit = env.makeWindow({ wmClass: 'Gedit', instance: 'gedit', frame: { x: 0, y: 0, width: 400, height: 300 } });
    open(env, gedit);
    assert.deepEqual(gedit.moves, []); // the imported entry is not there
    assert.equal(fs.readFileSync(env.statePath, 'utf8'), '{broken');
});

test('importState throws and changes nothing when the restored state cannot be written', () => {
    const env = install();
    seedState(env, [seedEntry({ id: 'before' })]);
    const s = load(env);
    failMovesFrom('state.json.tmp'); // the temporary file cannot be renamed over the state file, as on a full disk
    stageImport(env, [fullEntry({ id: 'imp-gedit', key: 'gedit|gedit', wmClass: 'Gedit', instance: 'gedit',
        rel: { x: 300, y: 200, w: 640, h: 480 } })]);
    assert.throws(() => s.callbacks.importState(), { name: 'Error', message: /^\[window-memory\] .*cannot be written/ });
    assert.equal(fs.existsSync(stagingPath(env)), false); // the staging file is removed all the same
    assert.deepEqual(readState(env).windows.map(e => e.id), ['before']); // the file on disk is as it was
    const gedit = env.makeWindow({ wmClass: 'Gedit', instance: 'gedit', frame: { x: 0, y: 0, width: 400, height: 300 } });
    open(env, gedit);
    assert.deepEqual(gedit.moves, []); // the imported entry is not in memory either
    const firefox = env.makeWindow({ frame: { x: 0, y: 0, width: 400, height: 300 } });
    open(env, firefox);
    assert.deepEqual(firefox.moves, [[100, 50, 800, 600]]); // the entry from before is still used
});

// A dialog and the main window of an application share a key (class and instance). With include-dialogs on, each
// must get the entry saved for its own kind of window, whatever the role, or the main window opens at a dialog's place.
test('with dialogs remembered, a main window and a dialog of one application each get the entry of their own type', () => {
    const env = install({ settings: { 'include-dialogs': true } });
    seedState(env, [
        seedEntry({ id: 'main', lastSeen: 1, rel: { x: 100, y: 50, w: 800, h: 600 } }), // saved before the type was recorded
        seedEntry({ id: 'dlg', lastSeen: 9, type: 'dialog', rel: { x: 400, y: 300, w: 300, h: 200 } }),
    ]);
    load(env);
    const main = env.makeWindow({ frame: { x: 0, y: 0, width: 400, height: 300 } });
    open(env, main);
    assert.deepEqual(main.moves, [[100, 50, 800, 600]]);
    const dialog = env.makeWindow({ type: 1, frame: { x: 0, y: 0, width: 400, height: 300 } });
    open(env, dialog);
    assert.deepEqual(dialog.moves, [[400, 300, 300, 200]]);
});

test('a dialog that was opened before the main window does not take the main window\'s entry', () => {
    const env = install({ settings: { 'include-dialogs': true } });
    seedState(env, [seedEntry({ id: 'main', rel: { x: 100, y: 50, w: 800, h: 600 } })]);
    load(env);
    const dialog = env.makeWindow({ type: 1, frame: { x: 0, y: 0, width: 400, height: 300 } });
    open(env, dialog);
    assert.deepEqual(dialog.moves, []);
    const main = env.makeWindow({ frame: { x: 0, y: 0, width: 400, height: 300 } });
    open(env, main);
    assert.deepEqual(main.moves, [[100, 50, 800, 600]]);
});

test('a capture records the type of the window on its entry', () => {
    const env = install({ settings: { 'include-dialogs': true } });
    load(env);
    const main = env.makeWindow({ frame: { x: 10, y: 20, width: 500, height: 400 } });
    const dialog = env.makeWindow({ type: 1, frame: { x: 30, y: 40, width: 300, height: 200 } });
    open(env, main);
    open(env, dialog);
    for (const w of [main, dialog]) w.emit('position-changed', w);
    env.runTimers();
    const types = readState(env).windows.map(e => e.type).sort();
    assert.deepEqual(types, ['dialog', 'normal']);
});

test('a staging file that cannot be removed after a successful import is logged once, and the import stands', () => {
    const env = install();
    seedState(env, [seedEntry({ id: 'before' })]);
    const s = load(env);
    const imported = [fullEntry({ id: 'imp', rel: { x: 300, y: 200, w: 640, h: 480 } })];
    stageImport(env, imported);
    failDeletesFrom('/import-pending.json');
    assert.doesNotThrow(() => s.callbacks.importState());
    assert.deepEqual(readState(env).windows, imported);
    assert.equal(fs.existsSync(stagingPath(env)), true); // the removal failed (the page removes it after the call)
    assert.equal(env.errors.length, 1);
    assert.match(env.errors[0], /^\[window-memory\] removing .*import-pending\.json failed: /);
    const w = env.makeWindow({ frame: { x: 0, y: 0, width: 400, height: 300 } });
    open(env, w);
    assert.deepEqual(w.moves, [[300, 200, 640, 480]]); // restored from the imported entry
});

test('when a failed import cannot remove its staging file either, the error of the import is the one thrown', () => {
    const env = install();
    seedState(env, [seedEntry({ id: 'before' })]);
    const s = load(env);
    const saved = fs.readFileSync(env.statePath, 'utf8');
    stageImport(env, '{broken');
    failDeletesFrom('/import-pending.json');
    assert.throws(() => s.callbacks.importState(),
        { name: 'Error', message: "[window-memory] import rejected: the backup's window list is not readable" });
    assert.equal(env.errors.length, 1); // the failed removal is logged
    assert.match(env.errors[0], /removing .*import-pending\.json failed: /);
    env.runTimers();
    assert.equal(fs.readFileSync(env.statePath, 'utf8'), saved);
});

test('a window whose binding fails during an import is logged, the other open windows are still bound, and the import stands', () => {
    const env = install();
    const s = load(env);
    const broken = env.makeWindow({});
    const fine = env.makeWindow({ wmClass: 'Gedit', instance: 'gedit' });
    open(env, broken);
    open(env, fine);
    stageImport(env, [
        fullEntry({ id: 'imp-firefox', lastSeen: 1, rel: { x: 10, y: 10, w: 500, h: 400 } }),
        fullEntry({ id: 'imp-gedit', key: 'gedit|gedit', wmClass: 'Gedit', instance: 'gedit', lastSeen: 2,
            rel: { x: 20, y: 20, w: 500, h: 400 } }),
    ]);
    const getTitle = broken.get_title;
    broken.get_title = () => { throw new Error('the window is gone'); }; // its claim throws
    try {
        assert.doesNotThrow(() => s.callbacks.importState());
    } finally {
        broken.get_title = getTitle;
    }
    assert.equal(env.errors.length, 1);
    assert.match(env.errors[0], /^\[window-memory\] binding an open window to an imported entry failed: /);
    fine.frame = { x: 50, y: 60, width: 640, height: 480 };
    fine.emit('position-changed', fine);
    env.runTimers();
    // fine took imp-gedit: its move updated that entry and added none. imp-firefox is as imported.
    const rels = Object.fromEntries(readState(env).windows.map(e => [e.id, e.rel]));
    assert.deepEqual(rels, {
        'imp-firefox': { x: 10, y: 10, w: 500, h: 400 },
        'imp-gedit': { x: 50, y: 60, w: 640, h: 480 },
    });
    assert.deepEqual(fine.moves, []);
});

test('a failed import leaves a forgotten window paused and a bound window on its own entry', () => {
    const env = install();
    seedState(env, [seedEntry({ id: 'kept' })]);
    const bound = env.makeWindow({});
    env.windows.push(bound); // open at enable: it claims kept
    const s = load(env);
    const forgotten = env.makeWindow({ wmClass: 'Gedit', instance: 'gedit' });
    open(env, forgotten);
    env.display.emit('grab-op-end', env.display, forgotten); // saved under an entry of its own
    env.runTimers();
    env.display.focus_window = forgotten;
    s.callbacks.forgetFocused(); // its entry is removed, and it is paused until it is dragged
    env.runTimers();
    const before = fs.readFileSync(env.statePath, 'utf8');
    stageImport(env, '{broken');
    assert.throws(() => s.callbacks.importState(), REJECTED);
    assert.equal(fs.readFileSync(env.statePath, 'utf8'), before);
    forgotten.frame = { x: 50, y: 60, width: 640, height: 480 };
    forgotten.emit('position-changed', forgotten); // still paused: not saved
    bound.frame = { x: 300, y: 200, width: 900, height: 700 };
    bound.emit('position-changed', bound); // still on kept
    env.runTimers();
    const windows = readState(env).windows;
    assert.deepEqual(windows.map(e => e.id), ['kept']);
    assert.deepEqual(windows[0].rel, { x: 300, y: 200, w: 900, h: 700 });
    assert.equal(env.errors, undefined);
});

// The settings of the backup are set by the page after importState returns, so during the call max-entries and the
// never-remember list are still the ones being replaced: nothing is pruned or left out by them.
test('an import keeps every entry of the backup, beyond max-entries and for applications on the never-remember list', () => {
    const env = install({ settings: { 'max-entries': 10, 'excluded-apps': [{ wmclass: 'gedit' }] } });
    const s = load(env);
    const imported = [];
    for (let i = 1; i <= 12; i++) imported.push(fullEntry({ id: 'imp-' + i, lastSeen: i }));
    imported.push(fullEntry({ id: 'imp-gedit', key: 'gedit|gedit', wmClass: 'Gedit', instance: 'gedit', lastSeen: 13 }));
    stageImport(env, imported);
    s.callbacks.importState();
    assert.deepEqual(readState(env).windows, imported); // 13 entries with max-entries 10, gedit's too
    assert.equal(env.errors, undefined);
});

// The confirmation of "Forget the focused window": after the change, each press shows a notification titled "Window Memory"
// (Main.notify, ui/main.js:751-757). The body names the application by the name Cinnamon's window tracker knows it by,
// else by the window's WM_CLASS, and never by the window title. A notification that fails is logged, and the forget stands.
const NOTIFY_TITLE = 'Window Memory';
const FOCUSED_NOT_REMEMBERED = 'The focused window is not remembered, so nothing was forgotten.';
const TITLE = 'Quarterly report.odt'; // the title of the test windows, which no notification may contain

// Opens w and saves it as a drag does, so that it has an entry in the state file.
function openSaved(env, w) {
    open(env, w);
    env.display.emit('grab-op-end', env.display, w);
    env.runTimers();
}

test('the shortcut on a remembered window removes its entry, then notifies that the window of its application was forgotten', () => {
    const env = install({ settings: { 'forget-focused': '<Super>f' } });
    load(env);
    const w = env.makeWindow({ title: TITLE, app: { name: 'Firefox Web Browser' } });
    openSaved(env, w);
    assert.equal(readState(env).windows.length, 1);
    const Main = globalThis.imports.ui.main;
    const notify = Main.notify;
    const savesWaiting = []; // at each notification: the timers waiting, which are the save of the change, if any
    Main.notify = (title, body) => {
        savesWaiting.push(env.timers.size);
        notify(title, body);
    };
    env.display.focus_window = w;
    env.hotkeys[HOTKEY].callback();
    assert.deepEqual(env.notifications, [[NOTIFY_TITLE, 'Forgot the remembered window of Firefox Web Browser.']]);
    assert.deepEqual(savesWaiting, [1], 'the save of the change is scheduled before the notification');
    env.runTimers();
    assert.deepEqual(readState(env).windows, []);

    // A second press finds the window still tracked, with no entry left.
    env.hotkeys[HOTKEY].callback();
    assert.deepEqual(env.notifications[1], [NOTIFY_TITLE, 'Firefox Web Browser is not remembered, so nothing was forgotten.']);
    assert.equal(env.notifications.length, 2);
    assert.ok(env.notifications.every(n => !n[1].includes(TITLE)), 'no notification names the window title');
    assert.equal(env.errors, undefined);
});

test('the shortcut on a tracked window with no saved entry notifies that its application is not remembered, and still pauses it', () => {
    const env = install();
    const s = load(env);
    const w = env.makeWindow({ title: TITLE, app: { name: 'Firefox Web Browser' } });
    open(env, w); // never moved: no entry
    env.display.focus_window = w;
    s.callbacks.forgetFocused();
    assert.deepEqual(env.notifications, [[NOTIFY_TITLE, 'Firefox Web Browser is not remembered, so nothing was forgotten.']]);
    w.emit('unmanaging', w); // paused: closing it saves nothing
    w.emit('unmanaged', w);
    env.runTimers();
    assert.equal(fs.existsSync(env.statePath) ? readState(env).windows.length : 0, 0);
    assert.equal(env.errors, undefined);
});

test('the shortcut with no focused window, or with one that is not tracked, notifies that the focused window is not remembered', () => {
    const env = install({ settings: { 'excluded-apps': [{ wmclass: 'gimp' }] } });
    const s = load(env);
    const remembered = env.makeWindow({ app: { name: 'Firefox Web Browser' } });
    openSaved(env, remembered);
    const excluded = env.makeWindow({ wmClass: 'Gimp', instance: 'gimp', title: TITLE, app: { name: 'GNU Image Manipulation Program' } });
    // Dialogs are not remembered while "Also remember dialog windows" is off, its default.
    const dialog = env.makeWindow({ wmClass: 'Gedit', instance: 'gedit', type: 1, title: TITLE, app: { name: 'Text Editor' } });
    open(env, excluded);
    open(env, dialog);
    for (const focused of [null, excluded, dialog]) {
        env.display.focus_window = focused;
        s.callbacks.forgetFocused();
    }
    assert.deepEqual(env.notifications, [
        [NOTIFY_TITLE, FOCUSED_NOT_REMEMBERED], [NOTIFY_TITLE, FOCUSED_NOT_REMEMBERED], [NOTIFY_TITLE, FOCUSED_NOT_REMEMBERED],
    ]);
    env.runTimers();
    assert.equal(readState(env).windows.length, 1, 'the remembered window keeps its entry');
    assert.equal(env.errors, undefined);
});

test('the notification names an application that Cinnamon does not know by its WM_CLASS, and never by the window title', () => {
    const apps = [
        ['no application', null],
        // An application with no .desktop file is window-backed: Cinnamon does not know it, whatever name it gives.
        ['a window-backed application', { name: TITLE, windowBacked: true }],
        ['an application with no name', { name: '' }],
    ];
    for (const [label, app] of apps) {
        const env = install();
        const s = load(env);
        const w = env.makeWindow({ wmClass: 'LibreOffice', instance: 'libreoffice-writer', title: TITLE, app: app });
        openSaved(env, w);
        env.display.focus_window = w;
        s.callbacks.forgetFocused();
        s.callbacks.forgetFocused();
        assert.deepEqual(env.notifications, [
            [NOTIFY_TITLE, 'Forgot the remembered window of LibreOffice.'],
            [NOTIFY_TITLE, 'LibreOffice is not remembered, so nothing was forgotten.'],
        ], label);
        assert.equal(env.errors, undefined, label);
        s.ext.disable();
    }
});

test('a notification that fails is logged, and the forget stands', () => {
    const failures = [
        ['Main.notify', () => { globalThis.imports.ui.main.notify = () => { throw new Error('notify refused'); }; }],
        ['the window tracker', () => { globalThis.imports.gi.Cinnamon.WindowTracker.get_default = () => { throw new Error('no tracker'); }; }],
    ];
    for (const [what, fail] of failures) {
        const env = install();
        const s = load(env);
        const w = env.makeWindow({ title: TITLE, app: { name: 'Firefox Web Browser' } });
        openSaved(env, w);
        env.display.focus_window = w;
        fail();
        assert.doesNotThrow(() => s.callbacks.forgetFocused(), what);
        env.runTimers();
        assert.deepEqual(readState(env).windows, [], what);
        assert.equal(env.errors.length, 1, what);
        assert.match(env.errors[0], /^\[window-memory\] .*notification.*: Error: (notify refused|no tracker)$/, what);
        assert.deepEqual(env.notifications, [], what);
        // Still paused: a change the application makes is not saved.
        w.frame = { x: 10, y: 10, width: 400, height: 300 };
        w.emit('size-changed', w);
        env.runTimers();
        assert.deepEqual(readState(env).windows, [], what);
        s.ext.disable();
    }
});

test('a forget that fails is logged and notifies that the window could not be forgotten', () => {
    const env = install();
    const s = load(env);
    const w = env.makeWindow({ app: { name: 'Firefox Web Browser' } });
    openSaved(env, w);
    env.display.focus_window = w;
    const removeEntry = Store.removeEntry;
    Store.removeEntry = () => { throw new Error('broken on purpose'); };
    try {
        s.callbacks.forgetFocused();
        assert.deepEqual(env.notifications, [[NOTIFY_TITLE, 'Could not forget the remembered window. See the log.']]);
        assert.deepEqual(env.errors, ['[window-memory] forget focused failed: Error: broken on purpose']);
        // If that notification fails too, it is logged as well, and nothing is thrown at the key binding.
        globalThis.imports.ui.main.notify = () => { throw new Error('notify refused'); };
        assert.doesNotThrow(() => s.callbacks.forgetFocused());
        assert.equal(env.errors.length, 3);
        assert.equal(env.errors[1], '[window-memory] forget focused failed: Error: broken on purpose');
        assert.match(env.errors[2], /^\[window-memory\] .*notification.*: Error: notify refused$/);
    } finally {
        Store.removeEntry = removeEntry;
    }
});

// The notifications are translated in the domain of the uuid. The Spices installer compiles po/<lang>.po into
// <user data dir>/locale/<lang>/LC_MESSAGES/<uuid>.mo (python3/cinnamon/harvester.py:44-45; Cinnamon 6.0's bin/Spices.py:27
// always uses ~/.local/share/locale, the default user data dir), and enable() binds the domain to that folder. With no translation (the mock's default) the texts stay in
// English: the tests above.
test('enable binds the translation domain of the extension to the locale folder of the user data dir', () => {
    const env = install();
    load(env);
    assert.deepEqual(env.textDomains, [['window-memory@bootkicker', env.homeDir + '/.local/share/locale']]);
});

test('the translation domain follows a user data dir moved away from ~/.local/share (XDG_DATA_HOME)', () => {
    const env = install();
    env.userDataDir = path.join(env.configDir, 'data-home');
    load(env);
    assert.deepEqual(env.textDomains, [['window-memory@bootkicker', env.userDataDir + '/locale']]);
});

test('every notification is translated in the domain of the extension, with the application name where the translation has %s', () => {
    const env = install();
    env.translations['window-memory@bootkicker'] = {
        'Window Memory': 'Mémoire des fenêtres',
        'Forgot the remembered window of %s.': 'La fenêtre mémorisée de %s a été oubliée.',
        '%s is not remembered, so nothing was forgotten.': "Rien n'a été oublié : %s n'est pas mémorisée.",
        'The focused window is not remembered, so nothing was forgotten.': "La fenêtre active n'est pas mémorisée : rien n'a été oublié.",
        'Could not forget the remembered window. See the log.': "Impossible d'oublier la fenêtre mémorisée. Voir le journal.",
    };
    // The same texts in another domain must not be used.
    env.translations.cinnamon = { 'Window Memory': 'wrong domain', 'Forgot the remembered window of %s.': 'wrong domain %s' };
    const s = load(env);
    // A name with the $ patterns of String.prototype.replace is put in as it is.
    const w = env.makeWindow({ title: TITLE, app: { name: "L'Éditeur $& $1 $$" } });
    openSaved(env, w);
    env.display.focus_window = w;
    const removeEntry = Store.removeEntry;
    Store.removeEntry = () => { throw new Error('broken on purpose'); };
    try {
        s.callbacks.forgetFocused(); // the forget fails
    } finally {
        Store.removeEntry = removeEntry;
    }
    s.callbacks.forgetFocused(); // removes the entry
    s.callbacks.forgetFocused(); // no entry left
    env.display.focus_window = null;
    s.callbacks.forgetFocused(); // no window
    const title = 'Mémoire des fenêtres';
    assert.deepEqual(env.notifications, [
        [title, "Impossible d'oublier la fenêtre mémorisée. Voir le journal."],
        [title, "La fenêtre mémorisée de L'Éditeur $& $1 $$ a été oubliée."],
        [title, "Rien n'a été oublié : L'Éditeur $& $1 $$ n'est pas mémorisée."],
        [title, "La fenêtre active n'est pas mémorisée : rien n'a été oublié."],
    ]);
    // The log stays in English.
    assert.deepEqual(env.errors, ['[window-memory] forget focused failed: Error: broken on purpose']);
});

// Forget all writes the emptied state at once, not only at its debounced save: the settings page counts the remembered
// windows in the file before each click (forget_button.py), so a second click right after the first must read none.
test('forgetAll writes the emptied state file at once, before any timer runs', () => {
    const env = install();
    const s = load(env);
    const a = env.makeWindow({});
    const b = env.makeWindow({ wmClass: 'Gedit', instance: 'gedit' });
    openSaved(env, a);
    openSaved(env, b);
    assert.equal(readState(env).windows.length, 2);
    s.callbacks.forgetAll();
    assert.deepEqual(readState(env).windows, []); // no timer has run since the call
    env.runTimers();
    assert.deepEqual(readState(env).windows, []);
    assert.equal(env.errors, undefined);
});

test('forgetAll does not write over a state file that could not be moved aside', () => {
    const env = install();
    fs.mkdirSync(path.dirname(env.statePath), { recursive: true });
    fs.writeFileSync(env.statePath, '{broken');
    failMovesFrom('/state.json');
    const s = load(env);
    s.callbacks.forgetAll();
    assert.equal(fs.readFileSync(env.statePath, 'utf8'), '{broken');
    env.runTimers();
    assert.equal(fs.readFileSync(env.statePath, 'utf8'), '{broken');
    assert.deepEqual(fs.readdirSync(path.dirname(env.statePath)).filter(f => f !== 'safety.json'), ['state.json']);
});

test('extension.js loads with Cinnamon 6.8\'s native importer, where `module` is undefined, and exports init, enable and disable as top-level functions', () => {
    const env = install();
    let ext;
    assert.doesNotThrow(() => { ext = loadNative(); });
    for (const name of ['init', 'enable', 'disable']) assert.equal(typeof ext[name], 'function', name);
    ext.init({ uuid: 'window-memory@bootkicker' });
    const callbacks = ext.enable();
    assert.equal(typeof callbacks, 'object');
    ext.disable();
    assert.equal(env.errors, undefined);
});

test('extension.js still exports init, enable and disable through module.exports when require() loads it', () => {
    install();
    delete require.cache[EXT];
    const ext = require(EXT);
    assert.deepEqual(Object.keys(ext).sort(), ['disable', 'enable', 'init']);
});

// The Spices reviewers' rule: a GLib source or Meta later callback returns GLib.SOURCE_REMOVE or SOURCE_CONTINUE, not a
// bare boolean (cinnamon-spices-extensions .github/copilot-instructions.md:136-137).
test('every Meta.later_add callback returns GLib.SOURCE_REMOVE, not a bare false', () => {
    const src = fs.readFileSync(EXT, 'utf8');
    const starts = [...src.matchAll(/Meta\.later_add\(/g)].map(m => m.index);
    assert.ok(starts.length >= 2, 'the laters are found');
    for (const start of starts) {
        const body = src.slice(start, src.indexOf('\n                });', start));
        assert.doesNotMatch(body, /return (false|true)\b/, body.split('\n')[0]);
        assert.match(body, /return GLib\.SOURCE_REMOVE;/);
    }
});
