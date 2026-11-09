// SPDX-License-Identifier: GPL-3.0-or-later
// "Pick a window to start at login" in extension.js: pickStartupWindow() is the modal pick of "Pick a window", but a click
// writes what the window is (an application with a desktop file, or a command line) to the hidden key startup-pick, as the
// JSON text of lib/startupPick.js, and leaves excluded-apps alone. The settings tab (a separate process) reads the key.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { install } = require('./helpers/cinnamon-mock.js');
const { loadExtension, lib } = require('./helpers/load-cinnamon-module.js');
const Safety = lib('safety');

const EXT = path.join(__dirname, '..', 'files', 'window-memory@bootkicker', 'extension.js');
const ESCAPE = 65307; // Clutter.KEY_Escape
const PICK_MS = 20000;
const KEY = 'startup-pick';

function load() {
    const ext = loadExtension();
    ext.init({ uuid: 'window-memory@bootkicker' });
    const callbacks = ext.enable();
    return { ext, callbacks };
}

function addWindow(env, over) {
    const w = env.makeWindow(over);
    env.windows.push(w);
    return w;
}

const frame = (x, y, w, h) => ({ x: x, y: y, width: w, height: h });

function click(env, x, y) {
    env.sendStageEvent(env.pressEvent(x, y));
    return env.sendStageEvent(env.releaseEvent(x, y));
}

const picks = env => env.setValueCalls.filter(c => c[0] === KEY).map(c => c[1]);

function assertPickOver(env) {
    assert.deepEqual(env.modalStack, []);
    assert.equal(env.modalPops, env.modalPushes);
    assert.equal(env.endModalCalls.length, env.modalPushes);
    assert.equal(env.stageInputMode, 1);
    assert.equal(env.timers.size, 0, 'timeout cleared');
    assert.equal((env.stage.handlers['captured-event'] || []).length, 0, 'stage handler disconnected');
    assert.equal(env.cursor, null);
}

// What a pick leaves running, as numbers a test can compare: the same for both callbacks.
function snapshot(env) {
    return {
        pushes: env.modalPushes, stack: env.modalStack.length, children: env.uiGroup.children.length, cursor: env.cursor,
        input: env.stageInputMode, handlers: (env.stage.handlers['captured-event'] || []).length,
        timers: env.timers.size, delays: [...env.timerMs.values()],
    };
}

test('the schema declares the hidden key: a generic with an empty default and no description', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(path.dirname(EXT), 'settings-schema.json'), 'utf8'));
    assert.deepEqual(schema[KEY], { type: 'generic', default: '' });
});

test('enable() returns pickStartupWindow, a function, with the other callbacks', () => {
    install();
    const s = load();
    assert.deepEqual(Object.keys(s.callbacks).sort(), ['forgetAll', 'forgetFocused', 'importState', 'pickStartupWindow', 'pickWindow']);
    assert.equal(typeof s.callbacks.pickStartupWindow, 'function');
});

test('pickStartupWindow starts the same modal pick as pickWindow: the same grab, actor, cursor, handler and one timeout', () => {
    const envA = install();
    const a = load();
    a.callbacks.pickWindow();
    const normal = snapshot(envA);
    const envB = install();
    const b = load();
    b.callbacks.pickStartupWindow();
    assert.deepEqual(snapshot(envB), normal);
    assert.deepEqual(normal.delays, [PICK_MS]);
    assert.deepEqual(envB.setValueCalls, []);
    // A second start while it runs does nothing, whichever callback asks.
    b.callbacks.pickStartupWindow();
    b.callbacks.pickWindow();
    assert.deepEqual(snapshot(envB), normal);
    assert.equal(envB.errors, undefined);
});

test('a click on a window of an application with a desktop file writes kind app, once, and ends the pick', () => {
    const env = install({ settings: { 'excluded-apps': [{ wmclass: 'xed' }] } });
    const s = load();
    addWindow(env, { wmClass: 'Nemo', frame: frame(0, 0, 800, 600), pid: 4321,
        app: { name: 'Files', id: 'nemo.desktop', desktopFile: '/usr/share/applications/nemo.desktop' } });
    s.callbacks.pickStartupWindow();
    const before = Date.now();
    assert.equal(click(env, 100, 100), true);
    const after = Date.now();
    assert.equal(picks(env).length, 1);
    const value = JSON.parse(picks(env)[0]);
    assert.equal(value.v, 1);
    assert.ok(value.stamp >= before && value.stamp <= after, 'the stamp is Date.now()');
    assert.deepEqual({ kind: value.kind, desktopFile: value.desktopFile, name: value.name },
        { kind: 'app', desktopFile: '/usr/share/applications/nemo.desktop', name: 'Files' });
    assert.deepEqual(Object.keys(value), ['v', 'stamp', 'kind', 'desktopFile', 'name']);
    assert.deepEqual(env.setValueCalls.map(c => c[0]), [KEY], 'nothing else is written');
    assert.deepEqual(env.owner._settings.getValue('excluded-apps'), [{ wmclass: 'xed' }], 'excluded-apps is unchanged');
    assertPickOver(env);
    env.runIdles();
    assert.deepEqual(env.uiGroup.children, []);
    assert.equal(env.errors, undefined);
});

test('two picks of the same application write two different values (the stamp), so the tab sees each one', () => {
    const env = install();
    const s = load();
    addWindow(env, { wmClass: 'Nemo', frame: frame(0, 0, 800, 600), app: { name: 'Files', desktopFile: '/usr/share/applications/nemo.desktop' } });
    const realNow = Date.now;
    let t = 1730000000000;
    Date.now = () => t++;
    try {
        s.callbacks.pickStartupWindow();
        click(env, 10, 10);
        s.callbacks.pickStartupWindow();
        click(env, 10, 10);
    } finally {
        Date.now = realNow;
    }
    const [one, two] = picks(env);
    assert.notEqual(one, two);
    assert.equal(JSON.parse(one).stamp, 1730000000000);
    assert.equal(JSON.parse(two).stamp, 1730000000001);
});

test('a window with no desktop file but a readable command line writes kind form with the quoted command', () => {
    const env = install();
    const s = load();
    addWindow(env, { wmClass: 'XTerm', frame: frame(0, 0, 800, 600), pid: 777, app: { name: 'XTerm', windowBacked: true } });
    env.procFiles['/proc/777/cmdline'] = Buffer.from('xterm\0-e\0sh -c "x; y"\0');
    s.callbacks.pickStartupWindow();
    click(env, 100, 100);
    const value = JSON.parse(picks(env)[0]);
    assert.deepEqual({ kind: value.kind, name: value.name, command: value.command },
        { kind: 'form', name: 'XTerm', command: 'xterm -e "sh -c \\"x; y\\""' });
    assert.deepEqual(Object.keys(value), ['v', 'stamp', 'kind', 'name', 'command']);
    assert.equal(env.errors, undefined);
    assertPickOver(env);
});

test('the command line is split at each NUL, so a name or an argument with a space stays one argument, and an empty argument stays', () => {
    const env = install();
    const s = load();
    addWindow(env, { wmClass: 'X', frame: frame(0, 0, 800, 600), pid: 8, app: null });
    env.procFiles['/proc/8/cmdline'] = Buffer.from('/opt/my app/run\0\0--x\0');
    s.callbacks.pickStartupWindow();
    click(env, 5, 5);
    const value = JSON.parse(picks(env)[0]);
    assert.equal(value.command, '"/opt/my app/run" "" --x');
    assert.equal(value.name, 'run');
});

test('a window with pid 0 writes kind form with an empty command and does not throw', () => {
    const env = install();
    const s = load();
    addWindow(env, { wmClass: 'Thing', frame: frame(0, 0, 800, 600), pid: 0, app: null });
    s.callbacks.pickStartupWindow();
    click(env, 100, 100);
    const value = JSON.parse(picks(env)[0]);
    assert.deepEqual({ kind: value.kind, name: value.name, command: value.command }, { kind: 'form', name: '', command: '' });
    assert.equal(env.errors, undefined);
    assertPickOver(env);
});

test('an unreadable command line, a pid that fails, and every window-tracker call that throws all end in a form with an empty command', () => {
    const cases = [
        { pid: 999 },                                      // /proc/999/cmdline is not there
        { pid: 5, pidThrows: true },
        { pid: 5, trackerThrows: true },
        { pid: 5, app: { name: 'X', infoThrows: true } },
    ];
    for (const over of cases) {
        const env = install();
        const s = load();
        addWindow(env, Object.assign({ wmClass: 'Thing', frame: frame(0, 0, 800, 600) }, over));
        s.callbacks.pickStartupWindow();
        click(env, 100, 100);
        assert.equal(picks(env).length, 1, JSON.stringify(over));
        const value = JSON.parse(picks(env)[0]);
        assert.equal(value.kind, 'form', JSON.stringify(over));
        assert.equal(value.command, '', JSON.stringify(over));
        assert.equal(env.errors, undefined, JSON.stringify(over));
        assertPickOver(env);
    }
});

test('an empty cmdline file (a zombie or a kernel thread) is a form with an empty command', () => {
    const env = install();
    const s = load();
    addWindow(env, { wmClass: 'Thing', frame: frame(0, 0, 800, 600), pid: 12, app: null });
    env.procFiles['/proc/12/cmdline'] = Buffer.alloc(0);
    s.callbacks.pickStartupWindow();
    click(env, 100, 100);
    assert.equal(JSON.parse(picks(env)[0]).command, '');
});

test('Escape, a click on no window, a click on a window that cannot be picked, and the timeout write nothing', () => {
    // Escape
    let env = install();
    let s = load();
    addWindow(env, { wmClass: 'Nemo', frame: frame(0, 0, 800, 600), app: { name: 'Files', desktopFile: '/x.desktop' } });
    s.callbacks.pickStartupWindow();
    env.sendStageEvent(env.keyEvent(ESCAPE));
    assert.deepEqual(env.setValueCalls, []);
    assertPickOver(env);
    // A click where there is no window
    s.callbacks.pickStartupWindow();
    click(env, 1900, 1000);
    assert.deepEqual(env.setValueCalls, []);
    assertPickOver(env);
    // A click on a dock
    addWindow(env, { wmClass: 'Panel', type: 3, frame: frame(0, 1000, 1920, 80) });
    s.callbacks.pickStartupWindow();
    click(env, 100, 1040);
    assert.deepEqual(env.setValueCalls, []);
    assertPickOver(env);
    // The timeout
    env = install();
    s = load();
    s.callbacks.pickStartupWindow();
    assert.deepEqual([...env.timerMs.values()], [PICK_MS]);
    env.runTimers();
    assert.deepEqual(env.setValueCalls, []);
    assertPickOver(env);
    assert.equal(env.errors, undefined);
});

test('a startup pick leaves the pending timers as a normal pick does, and no signal behind', () => {
    const run = callback => {
        const env = install();
        const s = load();
        addWindow(env, { wmClass: 'Nemo', frame: frame(0, 0, 800, 600), pid: 3, app: { name: 'Files', desktopFile: '/usr/share/applications/nemo.desktop' } });
        const timersBefore = env.timers.size;
        const connected = () => Object.values(env.stage.handlers).reduce((n, v) => n + v.length, 0);
        const handlersBefore = connected();
        s.callbacks[callback]();
        click(env, 100, 100);
        env.runIdles();
        assert.equal(env.timers.size, timersBefore);
        assert.equal(connected(), handlersBefore, 'no stage signal left connected');
        assertPickOver(env);
        return env.timers.size;
    };
    assert.equal(run('pickStartupWindow'), run('pickWindow'));
});

test('while stopped, pickStartupWindow only logs and writes nothing; it does not throw', () => {
    const env = install();
    fs.mkdirSync(path.dirname(env.safetyPath), { recursive: true });
    const stopped = Safety.stopRecord('restart-loop', 1, '6.0.5', '6.0.1', 'switch');
    fs.writeFileSync(env.safetyPath, Safety.serializeSafety({ stopped: stopped, starts: [] }));
    const { callbacks } = load();
    const lines = [];
    global.log = s => lines.push(String(s));
    assert.doesNotThrow(() => callbacks.pickStartupWindow());
    assert.deepEqual(lines, ['[window-memory] stopped; ignoring pickStartupWindow']);
    assert.equal(env.modalPushes, 0);
    assert.deepEqual(env.setValueCalls, []);
});

test('a normal pick still adds the class to excluded-apps and writes no startup-pick', () => {
    const env = install();
    const s = load();
    addWindow(env, { wmClass: 'Firefox', frame: frame(0, 0, 800, 600), app: { name: 'Firefox', desktopFile: '/f.desktop' }, pid: 1 });
    s.callbacks.pickWindow();
    click(env, 100, 100);
    assert.deepEqual(env.setValueCalls, [['excluded-apps', [{ enabled: true, wmclass: 'Firefox' }]]]);
});

test('the backup carries no startup-pick: it is neither a stored type of the backup page nor listed in a backup', () => {
    const body = fs.readFileSync(path.join(path.dirname(EXT), 'backup_buttons.py'), 'utf8');
    const stored = /^STORED_TYPES = \(([^)]*)\)/m.exec(body);
    assert.ok(stored);
    assert.doesNotMatch(stored[1], /generic/);
});

test('the startup pick shows its own hint, the same highlight, and a right-click cancels it with nothing written', () => {
    const env = install();
    const s = load();
    addWindow(env, { wmClass: 'Nemo', frame: frame(0, 0, 800, 600), pid: 3, app: { name: 'Files', desktopFile: '/usr/share/applications/nemo.desktop' } });
    s.callbacks.pickStartupWindow();
    const actor = env.modalStack[0];
    const [highlight, hint] = actor.children;
    assert.equal(hint.text, 'Click a window to start its application at login.  Esc or right-click to cancel.');
    assert.equal(highlight.visible, false);
    assert.equal(env.sendStageEvent(env.motionEvent(100, 100)), true);
    assert.equal(highlight.visible, true);
    assert.equal(highlight.children[0].text, 'Nemo');
    env.sendStageEvent(env.pressEvent(100, 100, 3)); // Clutter.BUTTON_SECONDARY
    env.sendStageEvent(env.releaseEvent(100, 100, 3));
    assert.deepEqual(picks(env), []);
    assertPickOver(env);
    env.runIdles();
    assert.equal(hint.destroyed, true);
    assert.equal(highlight.destroyed, true);
    assert.equal(env.errors, undefined);
});
