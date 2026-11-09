const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { install } = require('./helpers/cinnamon-mock.js');
const { loadExtension } = require('./helpers/load-cinnamon-module.js');

const EXT = path.join(__dirname, '..', 'files', 'window-memory@bootkicker', 'extension.js');

// A native Wayland window has no class when Muffin announces it: the app id arrives about 20 ms later, before the first
// size, and the window is shown after that (seen on Cinnamon 6.0.5 on Wayland). These tests cover a window whose
// class comes late.

function load() {
    const ext = loadExtension();
    ext.init({ uuid: 'window-memory@bootkicker' });
    ext.enable();
    return ext;
}

function readState(env) {
    return JSON.parse(fs.readFileSync(env.statePath, 'utf8'));
}

function seedEntry(over) {
    return Object.assign({
        id: 'e1', key: 'wl1|wl1', wmClass: 'WL1', instance: 'WL1', role: '', title: '', type: 'normal',
        lastSeen: 1, workspace: 0, maximized: false,
        monitor: { index: 0, x: 0, y: 0, w: 1920, h: 1080 }, rel: { x: 300, y: 200, w: 700, h: 450 },
    }, over || {});
}

function seed(env, entries) {
    fs.mkdirSync(path.dirname(env.statePath), { recursive: true });
    fs.writeFileSync(env.statePath, JSON.stringify({ version: 1, windows: entries }));
}

// A native window as announced: no class, no size yet.
function newNative(env) {
    return env.makeWindow({ wmClass: '', instance: '', clientType: 0, frame: { x: 0, y: 0, width: 0, height: 0 } });
}

function giveClass(w) {
    w.wmClass = 'WL1';
    w.instance = 'WL1';
}

function count(w) {
    return Object.values(w.handlers).reduce((n, list) => n + list.length, 0);
}

test('a window whose class arrives with notify::wm-class is restored before its map', () => {
    const env = install();
    seed(env, [seedEntry()]);
    load();
    const w = newNative(env);
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.moves, []); // nothing is known yet
    giveClass(w);
    w.emit('notify::wm-class', w, null);
    w.frame = { x: 0, y: 0, width: 700, height: 500 };
    w.emit('size-changed', w);
    assert.deepEqual(w.moves.slice(-1), [[300, 200, 700, 450]]);
    env.mapWindow(w);
    assert.deepEqual(w.frame, { x: 300, y: 200, width: 700, height: 450 });
    assert.equal(env.errors, undefined);
});

test('a window whose class is seen only at its first size-changed is restored then', () => {
    const env = install();
    seed(env, [seedEntry()]);
    load();
    const w = newNative(env);
    env.display.emit('window-created', env.display, w);
    giveClass(w); // no notify::wm-class sent
    w.frame = { x: 0, y: 0, width: 700, height: 500 };
    w.emit('size-changed', w);
    assert.deepEqual(w.moves.slice(-1), [[300, 200, 700, 450]]);
    env.mapWindow(w);
    assert.equal(env.errors, undefined);
});

test('a Muffin placement after the restore is corrected at the map', () => {
    const env = install();
    seed(env, [seedEntry()]);
    load();
    const w = newNative(env);
    env.display.emit('window-created', env.display, w);
    giveClass(w);
    w.emit('notify::wm-class', w, null);
    w.frame = { x: 50, y: 50, width: 700, height: 500 }; // Muffin's cascade after the size
    w.emit('position-changed', w);
    env.mapWindow(w);
    assert.deepEqual(w.frame, { x: 300, y: 200, width: 700, height: 450 });
});

test('after the map a late-class window is captured like any other', () => {
    const env = install();
    load();
    const w = newNative(env);
    env.display.emit('window-created', env.display, w);
    giveClass(w);
    w.emit('notify::wm-class', w, null);
    w.frame = { x: 50, y: 50, width: 700, height: 500 };
    w.emit('size-changed', w);
    env.mapWindow(w);
    w.frame = { x: 400, y: 120, width: 640, height: 400 };
    env.display.emit('grab-op-end', env.display, w);
    env.runTimers();
    const saved = readState(env).windows;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].key, 'wl1|wl1');
    assert.deepEqual(saved[0].rel, { x: 400, y: 120, w: 640, h: 400 });
});

test('a window that is already mapped when its class arrives is tracked without being moved', () => {
    const env = install();
    seed(env, [seedEntry()]);
    load();
    const w = newNative(env);
    env.display.emit('window-created', env.display, w);
    env.mapWindow(w); // mapped with no class
    giveClass(w);
    w.emit('notify::wm-class', w, null);
    assert.deepEqual(w.moves, []); // already shown: never moved
    w.frame = { x: 500, y: 90, width: 640, height: 400 };
    env.display.emit('grab-op-end', env.display, w);
    env.runTimers();
    const saved = readState(env).windows;
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0].rel, { x: 500, y: 90, w: 640, h: 400 }); // it claimed the entry and updated it
});

test('a window that never gets a class is ignored and leaves no handler behind', () => {
    const env = install();
    seed(env, [seedEntry()]);
    load();
    const w = newNative(env);
    env.display.emit('window-created', env.display, w);
    w.emit('size-changed', w);
    w.emit('position-changed', w);
    assert.deepEqual(w.moves, []);
    w.emit('unmanaged', w);
    assert.equal(count(w), 0);
    assert.equal(readState(env).windows.length, 1); // the seeded entry only
    assert.equal(env.errors, undefined);
});

test('disabling the extension drops the handlers of a window still waiting for its class', () => {
    const env = install();
    const ext = load();
    const w = newNative(env);
    env.display.emit('window-created', env.display, w);
    assert.ok(count(w) > 0);
    ext.disable();
    assert.equal(count(w), 0);
});

test('a window that has a class at window-created is tracked at once, as before', () => {
    const env = install();
    seed(env, [seedEntry()]);
    load();
    const w = env.makeWindow({ wmClass: 'WL1', instance: 'WL1', clientType: 0, frame: { x: 0, y: 0, width: 700, height: 500 } });
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.moves, [[300, 200, 700, 450]]);
    assert.equal(w.handlers['notify::wm-class'], undefined);
});

test('an X11 window with no class at window-created is ignored as before, with no wait', () => {
    const env = install();
    seed(env, [seedEntry()]);
    load();
    const w = env.makeWindow({ wmClass: '', instance: '', frame: { x: 0, y: 0, width: 300, height: 200 } }); // clientType 1: X11
    env.display.emit('window-created', env.display, w);
    assert.equal(count(w), 0);
    giveClass(w);
    w.emit('notify::wm-class', w, null);
    assert.deepEqual(w.moves, []);
});

test('a settings change while a window waits for its class does not track it as mapped', () => {
    const env = install();
    seed(env, [seedEntry()]);
    load();
    const w = newNative(env);
    env.display.emit('window-created', env.display, w);
    giveClass(w); // the class is there, the announcement has not come yet
    env.windows.push(w); // an open window for global.get_window_actors()
    env.changeSetting('include-dialogs', true); // runs _trackExisting
    assert.deepEqual(w.moves, []); // not tracked as mapped, not moved either
    w.emit('notify::wm-class', w, null); // the class announcement: tracked and restored now
    assert.deepEqual(w.moves.slice(-1), [[300, 200, 700, 450]]);
});
