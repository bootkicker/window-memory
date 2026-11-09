const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { install } = require('./helpers/cinnamon-mock.js');
const { loadExtension } = require('./helpers/load-cinnamon-module.js');

const EXT = path.join(__dirname, '..', 'files', 'window-memory@bootkicker', 'extension.js');

// Behavior that Cinnamon 6.0.5 on Wayland showed to differ from X11: a
// maximize that leaves the window where it was, a maximize lost on a window that is minimized, a monitor that Muffin's
// placement takes back, a window shown again that never sends 'shown', and a dialog that is a normal toplevel with a parent.

const TWO = [{ x: 0, y: 0, width: 1920, height: 1080 }, { x: 1920, y: 0, width: 1920, height: 1080 }];

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
        id: 'e1', key: 'wl1|wl1', wmClass: 'WL1', instance: 'WL1', role: '', title: '', type: 'normal',
        lastSeen: 1, workspace: 0, maximized: false,
        monitor: { index: 1, x: 1920, y: 0, w: 1920, h: 1080 }, rel: { x: 100, y: 100, w: 600, h: 350 },
    }, over || {});
}

function native(env, over) {
    return env.makeWindow(Object.assign({
        wmClass: 'WL1', instance: 'WL1', clientType: 0, frame: { x: 0, y: 0, width: 700, height: 500 },
    }, over || {}));
}

function opened(env, w) {
    env.display.emit('window-created', env.display, w);
}

// a maximize on Wayland arrives as a size-changed, with the position left where the window was.
test('a window restored maximized is moved to its monitor work area when the maximized size arrives', () => {
    const env = install({ wayland: true, monitors: TWO });
    seed(env, [entry({ maximized: true })]);
    load();
    const w = native(env);
    opened(env, w);
    env.mapWindow(w); // a native window is maximized at its first map (see the tests below)
    assert.ok(w.ops.includes('maximize'));
    w.frame = { x: 2020, y: 100, width: 1920, height: 1080 }; // the size came, the position stayed
    w.emit('size-changed', w);
    assert.deepEqual(w.frameMoves, [[1920, 0]]);
    w.emit('size-changed', w); // once only
    assert.equal(w.frameMoves.length, 1);
    assert.equal(env.errors, undefined);
});

// The rect that Muffin returns to when a window is un-maximized is the window's rect at the moment of the maximize
// (muffin core/window.c:2913-2927, meta_window_save_rect). A native Wayland window has no rect when it is created and
// Muffin places it itself a moment later, so a maximize at window-created made that default place the place to return to.
// The maximize of a native window waits for the first map, after the window was put at its saved place.
function recordRectAtMaximize(w) {
    const maximize = w.maximize;
    w.rectAtMaximize = null;
    w.maximize = flags => { w.rectAtMaximize = Object.assign({}, w.frame); maximize(flags); };
}

test('a native window restored maximized is maximized at its first map, after it is put at its saved place', () => {
    const env = install({ wayland: true, monitors: TWO });
    seed(env, [entry({ maximized: true })]);
    load();
    const w = native(env);
    recordRectAtMaximize(w);
    opened(env, w);
    assert.ok(!w.ops.includes('maximize'), 'not at window-created');
    w.frame = { x: 1970, y: 50, width: 700, height: 500 }; // Muffin placed it at its default place before the map
    w.monitor = 1;
    env.mapWindow(w);
    assert.deepEqual(w.rectAtMaximize, { x: 2020, y: 100, width: 600, height: 350 }, 'the saved place is the rect at the maximize');
    assert.equal(w.maximized, 3);
    assert.equal(w.ops.filter(o => o === 'maximize').length, 1);
    assert.equal(env.errors, undefined);
});

test('the later that corrects a hidden window does not maximize a native window: it runs before the window has a rect', () => {
    const env = install({ wayland: true, monitors: TWO });
    seed(env, [entry({ maximized: true })]);
    load();
    const w = native(env);
    recordRectAtMaximize(w);
    opened(env, w);
    w.monitor = 0; // not placed yet: it still reports the first monitor, not its saved one
    env.runLaters(); // BEFORE_REDRAW comes before the client's first commit: the window is still 0,0 0x0 and unplaced
    assert.ok(!w.ops.includes('maximize'), 'not in the later (not by its monitor check either)');
    w.frame = { x: 1970, y: 50, width: 700, height: 500 }; // Muffin places it after the first commit
    w.monitor = 1;
    env.mapWindow(w);
    assert.deepEqual(w.rectAtMaximize, { x: 2020, y: 100, width: 600, height: 350 }, 'the saved place is the rect at the maximize');
    assert.equal(w.ops.filter(o => o === 'maximize').length, 1);
});

test('a native window restored maximized that is first shown with no map is maximized at that show, at its saved place', () => {
    const env = install({ wayland: true, monitors: TWO });
    seed(env, [entry({ maximized: true })]);
    load();
    const w = native(env);
    recordRectAtMaximize(w);
    opened(env, w);
    env.runLaters();
    w.frame = { x: 1970, y: 50, width: 700, height: 500 }; // placed, hidden (another workspace)
    w.monitor = 1;
    assert.ok(!w.ops.includes('maximize'));
    w.emit('shown', w); // first shown during a workspace switch: Muffin sends 'shown' and no map
    assert.deepEqual(w.rectAtMaximize, { x: 2020, y: 100, width: 600, height: 350 });
    assert.equal(w.maximized, 3);
    env.mapWindow(w); // a map after that maximizes nothing again
    assert.equal(w.ops.filter(o => o === 'maximize').length, 1);
});

test('a native window that Muffin placed on another monitor is sent to its saved monitor and maximized there, once', () => {
    const env = install({ wayland: true, monitors: TWO });
    seed(env, [entry({ maximized: true })]);
    load();
    const w = native(env);
    recordRectAtMaximize(w);
    opened(env, w);
    assert.ok(!w.ops.includes('maximize'), 'not at window-created');
    w.frame = { x: 100, y: 50, width: 700, height: 500 }; // the pointer's monitor
    w.monitor = 0;
    env.mapWindow(w);
    assert.equal(w.monitor, 1);
    assert.equal(w.maximized, 3);
    assert.equal(w.ops.filter(o => o === 'maximize').length, 1);
    assert.ok(w.rectAtMaximize.x >= 1920, 'maximized on the saved monitor, at x ' + w.rectAtMaximize.x);
});

test('with size and position not remembered a native window restored maximized is still maximized, at its first map', () => {
    const env = install({ wayland: true, monitors: TWO, settings: { 'remember-size': false, 'remember-position': false } });
    seed(env, [entry({ maximized: true })]);
    load();
    const w = native(env);
    opened(env, w);
    assert.ok(!w.ops.includes('maximize'));
    env.mapWindow(w);
    assert.equal(w.maximized, 3);
});

test('a native window that is closed before its map is never maximized', () => {
    const env = install({ wayland: true, monitors: TWO });
    seed(env, [entry({ maximized: true })]);
    load();
    const w = native(env);
    opened(env, w);
    w.emit('unmanaging', w);
    w.emit('unmanaged', w); // the window is closed
    env.mapWindow(w);
    env.runLaters();
    assert.ok(!w.ops.includes('maximize'));
});

test('an XWayland window is maximized at window-created, as on X11', () => {
    const env = install({ wayland: true, monitors: TWO });
    seed(env, [entry({ maximized: true })]);
    load();
    const w = env.makeWindow({ wmClass: 'WL1', instance: 'WL1', clientType: 1, frame: { x: 0, y: 0, width: 700, height: 500 } });
    opened(env, w);
    assert.ok(w.ops.includes('maximize'));
});

test('an X11 window is maximized at window-created, as before', () => {
    const env = install({ monitors: TWO });
    seed(env, [entry({ maximized: true })]);
    load();
    const w = env.makeWindow({ wmClass: 'WL1', instance: 'WL1', frame: { x: 0, y: 0, width: 700, height: 500 } });
    opened(env, w);
    assert.equal(w.maximized, 3);
    assert.equal(w.ops.filter(o => o === 'maximize').length, 1);
});

test('the work area origin of a monitor with a panel is used', () => {
    const env = install({ wayland: true, monitors: TWO, workAreas: { 1: { x: 1920, y: 40, width: 1920, height: 1040 } } });
    seed(env, [entry({ maximized: true })]);
    load();
    const w = native(env);
    opened(env, w);
    env.mapWindow(w);
    w.frame = { x: 2020, y: 100, width: 1920, height: 1040 };
    w.emit('size-changed', w);
    assert.deepEqual(w.frameMoves, [[1920, 40]]);
});

test('nothing is moved on X11', () => {
    const env = install({ monitors: TWO });
    seed(env, [entry({ maximized: true })]);
    load();
    const w = env.makeWindow({ wmClass: 'WL1', instance: 'WL1', frame: { x: 0, y: 0, width: 700, height: 500 } });
    opened(env, w);
    w.frame = { x: 2020, y: 100, width: 1920, height: 1080 };
    w.emit('size-changed', w);
    assert.equal(w.frameMoves, undefined);
});

// a maximize is dropped when the window is minimized before it is shown; it is applied when the window is shown.
test('on Wayland a window restored maximized and minimized is maximized when it is un-minimized', () => {
    const env = install({ wayland: true, monitors: TWO });
    seed(env, [entry({ maximized: true, minimized: true })]);
    load();
    const w = native(env);
    opened(env, w);
    assert.ok(!w.ops.includes('maximize')); // not now: it would be lost
    env.runLaters();
    assert.ok(w.ops.includes('minimize'));
    assert.ok(w.minimized);
    w.monitor = 0; // Muffin put it elsewhere meanwhile: the un-minimize sends it back to its saved monitor
    w.unminimize();
    assert.equal(w.maximized, 3);
    assert.ok(w.ops.includes('maximize'));
    assert.equal(w.monitor, 1);
});

test('on X11 the maximize is tried at the restore and applied again at the un-minimize if it was dropped', () => {
    const env = install({ monitors: TWO });
    seed(env, [entry({ maximized: true, minimized: true })]);
    load();
    const w = env.makeWindow({ wmClass: 'WL1', instance: 'WL1', frame: { x: 0, y: 0, width: 700, height: 500 } });
    opened(env, w);
    assert.ok(w.ops.includes('maximize')); // as before: some applications keep it
    env.runLaters();
    w.maximized = 0; // dropped by the minimize (xterm on X11)
    w.monitor = 0; // and Muffin put it on another monitor
    w.unminimize();
    assert.equal(w.maximized, 3);
    assert.equal(w.ops.filter(o => o === 'maximize').length, 2);
    assert.equal(w.monitor, 1);
});

test('a window restored minimized only is not maximized when un-minimized', () => {
    const env = install({ wayland: true, monitors: TWO });
    seed(env, [entry({ minimized: true })]);
    load();
    const w = native(env);
    opened(env, w);
    env.runLaters();
    w.unminimize();
    assert.ok(!w.ops.includes('maximize'));
});

// Muffin on Wayland never sends 'shown' for a window shown again, so un-minimizing is its first show.
test('after a minimized restore and an un-minimize, the window is ready and its saved state is corrected', () => {
    const env = install({ wayland: true, monitors: TWO });
    seed(env, [entry({ minimized: true })]);
    load();
    const w = native(env);
    opened(env, w);
    w.handlers.shown = []; // no 'shown' from this Muffin
    env.runLaters();
    w.unminimize();
    env.runTimers();
    const saved = readState(env).windows;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].minimized, false); // without the first show the entry would stay minimized
    assert.deepEqual(saved[0].rel, { x: 100, y: 100, w: 600, h: 350 }); // the restored place is kept until a user move
    w.frame = { x: 2300, y: 200, width: 640, height: 400 };
    env.display.emit('grab-op-end', env.display, w);
    env.runTimers();
    assert.deepEqual(readState(env).windows[0].rel, { x: 380, y: 200, w: 640, h: 400 });
});

// Muffin's placement, after the restore moved the window to its saved monitor, takes it back to the pointer's monitor.
test('with size and position off the saved monitor is kept when Muffin places the window on another one', () => {
    const env = install({
        wayland: true, monitors: TWO, settings: { 'remember-size': false, 'remember-position': false },
    });
    seed(env, [entry()]);
    load();
    const w = native(env);
    opened(env, w);
    assert.equal(w.monitor, 1); // the restore sent it there
    w.monitor = 0; // Muffin's placement, hidden still
    env.mapWindow(w);
    assert.equal(w.monitor, 1);
    assert.equal(w.ops.filter(o => o === 'move_to_monitor:1').length, 2);
});

test('a window already on its saved monitor is not moved at the map', () => {
    const env = install({
        wayland: true, monitors: TWO, settings: { 'remember-size': false, 'remember-position': false },
    });
    seed(env, [entry()]);
    load();
    const w = native(env, { monitor: 1, frame: { x: 2000, y: 0, width: 700, height: 500 } });
    opened(env, w);
    env.mapWindow(w);
    assert.deepEqual(w.ops, []);
});

// a native dialog is a normal toplevel with a parent.
test('a native window with a parent is a dialog: with dialogs off it is neither saved nor restored', () => {
    const env = install({ wayland: true, monitors: TWO, settings: { 'include-dialogs': false } });
    seed(env, [entry({ key: 'xed|xed', wmClass: 'xed', instance: 'xed' })]);
    load();
    const main = native(env, { wmClass: 'xed', instance: 'xed' });
    const dlg = native(env, { wmClass: 'xed', instance: 'xed', transientFor: main, frame: { x: 10, y: 10, width: 300, height: 200 } });
    opened(env, dlg);
    assert.deepEqual(dlg.moves, []); // no restore of the main window's place
    env.mapWindow(dlg);
    dlg.frame = { x: 50, y: 60, width: 320, height: 210 };
    env.display.emit('grab-op-end', env.display, dlg);
    env.runTimers();
    assert.equal(readState(env).windows.length, 1);
    assert.deepEqual(readState(env).windows[0].rel, { x: 100, y: 100, w: 600, h: 350 }); // the main window's entry, untouched
});

test('with dialogs on, a native window with a parent is saved as a dialog and does not take over the main entry', () => {
    const env = install({ wayland: true, monitors: TWO, settings: { 'include-dialogs': true } });
    seed(env, [entry({ key: 'xed|xed', wmClass: 'xed', instance: 'xed' })]);
    load();
    const main = native(env, { wmClass: 'xed', instance: 'xed' });
    const dlg = native(env, { wmClass: 'xed', instance: 'xed', transientFor: main, frame: { x: 10, y: 10, width: 300, height: 200 } });
    opened(env, dlg);
    assert.deepEqual(dlg.moves, []); // the entry is a normal one
    env.mapWindow(dlg);
    dlg.frame = { x: 50, y: 60, width: 320, height: 210 };
    env.display.emit('grab-op-end', env.display, dlg);
    env.runTimers();
    const saved = readState(env).windows;
    assert.equal(saved.length, 2);
    assert.equal(saved.find(e => e.type === 'dialog').rel.w, 320);
    assert.deepEqual(saved.find(e => e.type === 'normal').rel, { x: 100, y: 100, w: 600, h: 350 });
});

test('an X11 window with a parent stays a normal window', () => {
    const env = install({ monitors: TWO });
    load();
    const main = env.makeWindow({ wmClass: 'Xed', instance: 'xed' });
    const w = env.makeWindow({ wmClass: 'Xed', instance: 'xed', transientFor: main, frame: { x: 10, y: 10, width: 300, height: 200 } });
    opened(env, w);
    env.mapWindow(w);
    w.frame = { x: 50, y: 60, width: 320, height: 210 };
    env.display.emit('grab-op-end', env.display, w);
    env.runTimers();
    assert.equal(readState(env).windows[0].type, 'normal');
});
