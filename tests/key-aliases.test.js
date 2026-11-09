const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { install } = require('./helpers/cinnamon-mock.js');
const { loadExtension } = require('./helpers/load-cinnamon-module.js');

const EXT = path.join(__dirname, '..', 'files', 'window-memory@bootkicker', 'extension.js');

// A window saved in an X11 session must be found in a Wayland session and the other way round, for the applications whose
// class differs between the two (gnome-terminal: X11 Gnome-terminal / gnome-terminal-server, Wayland gnome-terminal-server).

function load() {
    const ext = loadExtension();
    ext.init({ uuid: 'window-memory@bootkicker' });
    ext.enable();
    return ext;
}

function readState(env) {
    return JSON.parse(fs.readFileSync(env.statePath, 'utf8'));
}

function seed(env, entries) {
    fs.mkdirSync(path.dirname(env.statePath), { recursive: true });
    fs.writeFileSync(env.statePath, JSON.stringify({ version: 1, windows: entries }));
}

function entry(over) {
    return Object.assign({
        id: 'e1', key: 'gnome-terminal|gnome-terminal-server', wmClass: 'Gnome-terminal', instance: 'gnome-terminal-server',
        role: '', title: '', type: 'normal', lastSeen: 1, workspace: 0, maximized: false,
        monitor: { index: 0, x: 0, y: 0, w: 1920, h: 1080 }, rel: { x: 300, y: 200, w: 700, h: 450 },
    }, over || {});
}

const wayland = () => ({ wmClass: 'gnome-terminal-server', instance: 'gnome-terminal-server', clientType: 0 });
const x11 = () => ({ wmClass: 'Gnome-terminal', instance: 'gnome-terminal-server' });

test('a Wayland window finds the place saved by the same application on X11', () => {
    const env = install({ wayland: true });
    seed(env, [entry()]);
    load();
    const w = env.makeWindow(Object.assign(wayland(), { frame: { x: 0, y: 0, width: 600, height: 400 } }));
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.moves, [[300, 200, 700, 450]]);
    assert.equal(env.errors, undefined);
});

test('an X11 window finds the place saved by the same application on Wayland', () => {
    const env = install();
    seed(env, [entry({ key: 'gnome-terminal-server|gnome-terminal-server', wmClass: 'gnome-terminal-server' })]);
    load();
    const w = env.makeWindow(Object.assign(x11(), { frame: { x: 0, y: 0, width: 600, height: 400 } }));
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.moves, [[300, 200, 700, 450]]);
});

test('the entry that was found is updated by the window, not duplicated, and carries the key of the session in use', () => {
    const env = install({ wayland: true });
    seed(env, [entry()]);
    load();
    const w = env.makeWindow(Object.assign(wayland(), { frame: { x: 0, y: 0, width: 600, height: 400 } }));
    env.display.emit('window-created', env.display, w);
    env.mapWindow(w);
    w.frame = { x: 500, y: 300, width: 640, height: 400 };
    env.display.emit('grab-op-end', env.display, w);
    env.runTimers();
    const saved = readState(env).windows;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].id, 'e1');
    assert.equal(saved[0].key, 'gnome-terminal-server|gnome-terminal-server');
    assert.deepEqual(saved[0].rel, { x: 500, y: 300, w: 640, h: 400 });
});

test('the newest entry of the application is used, whichever session saved it', () => {
    const env = install({ wayland: true });
    seed(env, [
        entry({ id: 'old', key: 'gnome-terminal-server|gnome-terminal-server', lastSeen: 1, rel: { x: 10, y: 10, w: 500, h: 300 } }),
        entry({ id: 'new', lastSeen: 9, rel: { x: 300, y: 200, w: 700, h: 450 } }),
    ]);
    load();
    const w = env.makeWindow(Object.assign(wayland(), { frame: { x: 0, y: 0, width: 600, height: 400 } }));
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.moves, [[300, 200, 700, 450]]);
});

test('two windows of the application get two entries, one from each session', () => {
    const env = install({ wayland: true });
    seed(env, [
        entry({ id: 'a', lastSeen: 2, rel: { x: 100, y: 100, w: 500, h: 300 } }),
        entry({ id: 'b', key: 'gnome-terminal-server|gnome-terminal-server', lastSeen: 1, rel: { x: 900, y: 500, w: 500, h: 300 } }),
    ]);
    load();
    const w1 = env.makeWindow(Object.assign(wayland(), { frame: { x: 0, y: 0, width: 600, height: 400 } }));
    const w2 = env.makeWindow(Object.assign(wayland(), { frame: { x: 0, y: 0, width: 600, height: 400 } }));
    env.display.emit('window-created', env.display, w1);
    env.display.emit('window-created', env.display, w2);
    assert.deepEqual(w1.moves, [[100, 100, 500, 300]]);
    assert.deepEqual(w2.moves, [[900, 500, 500, 300]]);
});

test('an application with no alias keeps matching only its own key', () => {
    const env = install();
    seed(env, [entry({ key: 'firefox|navigator', wmClass: 'Firefox', instance: 'Navigator' })]);
    load();
    const w = env.makeWindow(Object.assign(x11(), { frame: { x: 0, y: 0, width: 600, height: 400 } }));
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.moves, []);
});

// Applications measured on both sessions (see identity.test.js): a native Wayland window finds the place that the X11 window of the
// same application saved, and the other way round.
const PAIRS = [
    ['Meld', 'org.gnome.meld', 'meld|org.gnome.meld', 'org.gnome.meld'],
    ['LibreOffice Writer', 'libreoffice-writer', 'libreoffice-writer|libreoffice', 'libreoffice'],
    ['LibreOffice Calc', 'libreoffice-calc', 'libreoffice-calc|libreoffice', 'libreoffice'],
    ['Drawing', 'com.github.maoschanz.drawing', 'drawing|com.github.maoschanz.drawing', 'com.github.maoschanz.drawing'],
];

for (const [name, appId, x11Key, x11Instance] of PAIRS) {
    test('a native Wayland window of ' + name + ' finds the place saved by its X11 window', () => {
        const env = install({ wayland: true });
        seed(env, [entry({ key: x11Key, wmClass: x11Key.split('|')[0], instance: x11Instance })]);
        load();
        const w = env.makeWindow({ wmClass: appId, instance: appId, clientType: 0, frame: { x: 0, y: 0, width: 600, height: 400 } });
        env.display.emit('window-created', env.display, w);
        assert.deepEqual(w.moves, [[300, 200, 700, 450]]);
    });

    test('an X11 window of ' + name + ' finds the place saved by its native Wayland window', () => {
        const env = install();
        seed(env, [entry({ key: appId + '|' + appId, wmClass: appId, instance: appId })]);
        load();
        const w = env.makeWindow({ wmClass: x11Key.split('|')[0], instance: x11Instance, frame: { x: 0, y: 0, width: 600, height: 400 } });
        env.display.emit('window-created', env.display, w);
        assert.deepEqual(w.moves, [[300, 200, 700, 450]]);
    });
}
