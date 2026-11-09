const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { install } = require('./helpers/cinnamon-mock.js');
const { loadExtension } = require('./helpers/load-cinnamon-module.js');

const EXT = path.join(__dirname, '..', 'files', 'window-memory@bootkicker', 'extension.js');

// An entry that a window of the same application (its desktop file id) saved as the other kind of client is used when no
// entry has the window's own key or an alias. It never applies to a window and entries of the same kind of client, so an
// X11 user, whose windows and entries are all X11, is never affected.

function load() {
    const ext = loadExtension();
    ext.init({ uuid: 'window-memory@bootkicker' });
    ext.enable();
    return ext;
}

const readState = env => JSON.parse(fs.readFileSync(env.statePath, 'utf8'));

function seed(env, entries) {
    fs.mkdirSync(path.dirname(env.statePath), { recursive: true });
    fs.writeFileSync(env.statePath, JSON.stringify({ version: 1, windows: entries }));
}

function entry(over) {
    return Object.assign({
        id: 'e1', key: 'myapp-x11|myapp-x11', wmClass: 'Myapp-x11', instance: 'myapp-x11', role: '', title: '', type: 'normal',
        lastSeen: 1, workspace: 0, maximized: false, appId: 'myapp.desktop', client: 'x11',
        monitor: { index: 0, x: 0, y: 0, w: 1920, h: 1080 }, rel: { x: 300, y: 200, w: 700, h: 450 },
    }, over || {});
}

const native = over => Object.assign({
    wmClass: 'myapp', instance: 'myapp', clientType: 0, app: { name: 'My app', id: 'myapp.desktop', windowBacked: false },
    frame: { x: 0, y: 0, width: 600, height: 400 },
}, over || {});

const x11 = over => Object.assign({
    wmClass: 'Myapp', instance: 'myapp', clientType: 1, app: { name: 'My app', id: 'myapp.desktop', windowBacked: false },
    frame: { x: 0, y: 0, width: 600, height: 400 },
}, over || {});

test('a native Wayland window finds the place saved by the same application as an X11 window with another key', () => {
    const env = install({ wayland: true });
    seed(env, [entry()]);
    load();
    const w = env.makeWindow(native());
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.moves, [[300, 200, 700, 450]]);
    assert.equal(env.errors, undefined);
});

test('an X11 window finds the place saved by the same application as a native Wayland window', () => {
    const env = install();
    seed(env, [entry({ key: 'myapp|myapp', wmClass: 'myapp', instance: 'myapp', client: 'wayland' })]);
    load();
    const w = env.makeWindow(x11({ wmClass: 'Other', instance: 'other' }));
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.moves, [[300, 200, 700, 450]]);
});

test('an X11 window never uses an entry saved by an X11 window of the same application', () => {
    const env = install();
    seed(env, [entry()]);
    load();
    const w = env.makeWindow(x11({ wmClass: 'Other', instance: 'other' }));
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.moves, []);
});

test('an entry saved before the fields existed counts as an X11 entry', () => {
    const env = install({ wayland: true });
    const old = entry();
    delete old.client;
    delete old.appId; // no application id either: nothing to match
    seed(env, [old]);
    load();
    const w = env.makeWindow(native());
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.moves, []);
    const withApp = entry();
    delete withApp.client; // an application id but no client: an X11 entry
    seed(env, [withApp]);
    load();
    const w2 = env.makeWindow(native());
    env.display.emit('window-created', env.display, w2);
    assert.deepEqual(w2.moves, [[300, 200, 700, 450]]);
});

test('the window\'s own key still wins over the learned entry', () => {
    const env = install({ wayland: true });
    seed(env, [
        entry({ id: 'learned', lastSeen: 9 }),
        entry({ id: 'own', key: 'myapp|myapp', client: 'wayland', lastSeen: 1, rel: { x: 50, y: 60, w: 500, h: 300 } }),
    ]);
    load();
    const w = env.makeWindow(native());
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.moves, [[50, 60, 500, 300]]);
});

test('a window whose application is only window-backed has no application id and no learned entry', () => {
    const env = install({ wayland: true });
    seed(env, [entry({ appId: 'window:19' })]);
    load();
    const w = env.makeWindow(native({ app: { name: 'x', id: 'window:19', windowBacked: true } }));
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.moves, []);
});

test('the dialog and normal windows of an application keep their own entries when learned', () => {
    const env = install({ wayland: true, settings: { 'include-dialogs': true } });
    seed(env, [entry({ type: 'dialog', rel: { x: 10, y: 10, w: 300, h: 200 } })]);
    load();
    const w = env.makeWindow(native()); // a normal window
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.moves, []);
});

test('a capture records the application id and the kind of client; a window-backed application records none', () => {
    const env = install({ wayland: true });
    load();
    const w = env.makeWindow(native());
    env.display.emit('window-created', env.display, w);
    env.mapWindow(w);
    w.frame = { x: 400, y: 120, width: 640, height: 400 };
    env.display.emit('grab-op-end', env.display, w);
    env.runTimers();
    let saved = readState(env).windows;
    assert.equal(saved[0].appId, 'myapp.desktop');
    assert.equal(saved[0].client, 'wayland');
    const env2 = install();
    load();
    const w2 = env2.makeWindow(x11({ app: { name: 'x', id: 'window:5', windowBacked: true } }));
    env2.display.emit('window-created', env2.display, w2);
    env2.mapWindow(w2);
    w2.frame = { x: 400, y: 120, width: 640, height: 400 };
    env2.display.emit('grab-op-end', env2.display, w2);
    env2.runTimers();
    saved = readState(env2).windows;
    assert.equal(saved[0].appId, null);
    assert.equal(saved[0].client, 'x11');
});

// Seen on Cinnamon 6.0.5: at notify::wm-class the window tracker still gives a window-backed placeholder; the real desktop
// application is known about 55 ms later, at the window's first size and position changes, before the map.
test('the application id that is known only after the class is used before the map', () => {
    const env = install({ wayland: true });
    seed(env, [entry()]);
    load();
    const w = env.makeWindow(native({ wmClass: '', instance: '', app: { name: 'x', id: 'window:39', windowBacked: true } }));
    env.display.emit('window-created', env.display, w);
    w.wmClass = 'myapp';
    w.instance = 'myapp';
    w.emit('notify::wm-class', w, null);
    assert.deepEqual(w.moves, []); // no entry yet: the application is still the placeholder
    w.app = { name: 'My app', id: 'myapp.desktop', windowBacked: false };
    w.frame = { x: 0, y: 0, width: 600, height: 400 };
    w.emit('size-changed', w);
    assert.deepEqual(w.moves, [[300, 200, 700, 450]]);
    env.mapWindow(w);
    assert.equal(env.errors, undefined);
});

test('an application id that arrives after the map is not used', () => {
    const env = install({ wayland: true });
    seed(env, [entry()]);
    load();
    const w = env.makeWindow(native({ app: { name: 'x', id: 'window:39', windowBacked: true } }));
    env.display.emit('window-created', env.display, w);
    env.mapWindow(w);
    w.app = { name: 'My app', id: 'myapp.desktop', windowBacked: false };
    w.emit('size-changed', w);
    assert.deepEqual(w.moves, []);
});

test('with no entry from the other kind of client the application id is never looked up again', () => {
    const env = install();
    seed(env, [entry()]); // saved by an X11 window
    load();
    let lookups = 0;
    const w = env.makeWindow(x11({ app: { name: 'x', id: 'window:39', windowBacked: true } }));
    const tracker = globalThis.imports.gi.Cinnamon.WindowTracker.get_default();
    const orig = tracker.get_window_app;
    tracker.get_window_app = x => { lookups++; return orig(x); };
    env.display.emit('window-created', env.display, w);
    const before = lookups;
    w.app = { name: 'My app', id: 'myapp.desktop', windowBacked: false };
    w.emit('size-changed', w);
    w.emit('position-changed', w);
    assert.equal(lookups, before);
    assert.deepEqual(w.moves, []);
    tracker.get_window_app = orig;
});
