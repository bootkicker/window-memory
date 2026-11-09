const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { install } = require('./helpers/cinnamon-mock.js');
const { loadExtension, lib } = require('./helpers/load-cinnamon-module.js');
const Safety = lib('safety');

const EXT = path.join(__dirname, '..', 'files', 'window-memory@bootkicker', 'extension.js');

// Stopped mode: safety.json with a stop makes enable() leave the extension doing nothing; one notification at the moment of
// a stop; the Enable switch resumes it. env.owner is the instance behind enable() (the mock's settings object gets it).

function load() {
    const ext = loadExtension();
    ext.init({ uuid: 'window-memory@bootkicker' });
    const callbacks = ext.enable();
    return { ext, callbacks };
}

const STATE_TEXT = JSON.stringify({ version: 1, windows: [] }, null, 2) + '\n  odd formatting that a rewrite would change\n';

function seedState(env, entries) {
    fs.mkdirSync(path.dirname(env.statePath), { recursive: true });
    fs.writeFileSync(env.statePath, JSON.stringify({ version: 1, windows: entries }));
}

function seedStop(env, over) {
    fs.mkdirSync(path.dirname(env.safetyPath), { recursive: true });
    const o = Object.assign({ reason: 'restart-loop', resume: 'switch' }, over || {});
    const stopped = Safety.stopRecord(o.reason, 1, '6.0.5', '6.0.1', o.resume);
    fs.writeFileSync(env.safetyPath, Safety.serializeSafety({ stopped: stopped, starts: [] }));
}

function readSafety(env) {
    return Safety.parseSafety(fs.readFileSync(env.safetyPath, 'utf8'));
}

function entry() {
    return {
        id: 'e1', key: 'firefox|navigator', wmClass: 'Firefox', instance: 'Navigator', role: '', title: '', type: 'normal',
        lastSeen: 1, workspace: 0, maximized: false, monitor: { index: 0, x: 0, y: 0, w: 1920, h: 1080 },
        rel: { x: 300, y: 200, w: 700, h: 450 },
    };
}

const PLACE = [[300, 200, 700, 450]];
const newWindow = env => env.makeWindow({ frame: { x: 0, y: 0, width: 600, height: 400 } });
const count = (emitter, sig) => (emitter.handlers[sig] || []).length;

const RESTART_SENTENCE = 'Window Memory stopped itself for safety: Cinnamon restarted repeatedly.';
const SWITCH_SENTENCE = 'To resume, turn "Enable Window Memory" off and on in its settings. If this happens again, please report an issue.';
const FILE_SENTENCE = 'To resume once the problem is fixed, delete ~/.config/window-memory/safety.json. If this happens again, please report an issue.';
const VERSIONS_LINE = 'Cinnamon 6.0.5, Muffin 6.0.1';

test('a safety.json with a stop starts the extension in stopped mode', () => {
    const env = install();
    fs.mkdirSync(path.dirname(env.statePath), { recursive: true });
    fs.writeFileSync(env.statePath, STATE_TEXT);
    const before = fs.readFileSync(env.statePath);
    seedStop(env);
    env.windows.push(newWindow(env));
    load();
    assert.equal(count(env.display, 'window-created'), 0);
    assert.equal(count(env.display, 'grab-op-begin'), 0);
    assert.equal(count(env.display, 'grab-op-end'), 0);
    assert.equal(count(env.wm, 'map'), 0);
    assert.deepEqual(env.hotkeys, {});
    assert.equal(env.timers.size, 0);
    assert.deepEqual(fs.readFileSync(env.statePath), before);
    assert.deepEqual(env.notifications, []);
    assert.equal(env.errors, undefined);
});

test('a window created while stopped is not tracked or restored', () => {
    const env = install();
    seedState(env, [entry()]);
    seedStop(env);
    load();
    const w = newWindow(env);
    env.display.emit('window-created', env.display, w);
    env.mapWindow(w);
    env.runTimers();
    assert.deepEqual(w.moves, []);
    assert.equal(env.errors, undefined);
});

test('the callbacks forgetAll, pickWindow and forgetFocused do nothing while stopped and do not throw; importState rejects', () => {
    const env = install();
    fs.mkdirSync(path.dirname(env.statePath), { recursive: true });
    fs.writeFileSync(env.statePath, STATE_TEXT);
    const before = fs.readFileSync(env.statePath);
    seedStop(env);
    const { callbacks } = load();
    callbacks.forgetAll();
    callbacks.pickWindow();
    callbacks.forgetFocused();
    assert.throws(() => callbacks.importState(), /import rejected/);
    assert.deepEqual(fs.readFileSync(env.statePath), before);
    assert.equal(env.modalPushes, 0);
    assert.deepEqual(env.notifications, []);
    assert.equal(env.errors, undefined);
});

test('a stopped callback logs \'stopped; ignoring <name>\' for forgetAll and pickWindow', () => {
    const env = install();
    seedStop(env);
    const { callbacks } = load();
    const lines = [];
    global.log = s => lines.push(String(s));
    callbacks.forgetAll();
    callbacks.pickWindow();
    assert.deepEqual(lines, ['[window-memory] stopped; ignoring forgetAll', '[window-memory] stopped; ignoring pickWindow']);
});

test('importState while stopped throws, and touches neither state.json nor the staging file', () => {
    const env = install();
    fs.mkdirSync(path.dirname(env.statePath), { recursive: true });
    fs.writeFileSync(env.statePath, STATE_TEXT);
    const before = fs.readFileSync(env.statePath);
    const staging = path.join(path.dirname(env.statePath), 'import-pending.json');
    fs.writeFileSync(staging, JSON.stringify({ version: 1, windows: [entry()] }));
    seedStop(env);
    const { callbacks } = load();
    assert.throws(() => callbacks.importState(),
        e => e.message === '[window-memory] import rejected: Window Memory is stopped for safety');
    assert.deepEqual(fs.readFileSync(env.statePath), before);
    assert.ok(fs.existsSync(staging), 'the staging file is left as it is');
    assert.equal(env.errors, undefined);
});

test('the notification of a stop has the title \'Window Memory\' and a body of the stop sentence, the resume sentence and the versions line', () => {
    const env = install({ cinnamonVersion: '6.0.5' });
    load();
    env.owner._stop('restart-loop', 'switch');
    assert.equal(env.notifications.length, 1);
    const [title, body] = env.notifications[0];
    assert.equal(title, 'Window Memory');
    assert.ok(body.startsWith(RESTART_SENTENCE), body);
    assert.ok(body.includes('\nCinnamon 6.0.5, Muffin 6.0.1'), body);
    assert.equal(body, RESTART_SENTENCE + '\n' + SWITCH_SENTENCE + '\n' + VERSIONS_LINE);
});

test('each reason has its own stop sentence', () => {
    const sentences = {
        'missing-call': 'Window Memory stopped itself for safety: a function it needs is missing from this version of Cinnamon.',
        'start-failed': 'Window Memory stopped itself for safety: it could not start.',
        'too-many-errors': 'Window Memory stopped itself for safety: too many errors.',
        'restart-loop': RESTART_SENTENCE,
    };
    for (const [reason, sentence] of Object.entries(sentences)) {
        const env = install();
        load();
        env.owner._stop(reason, 'switch');
        assert.equal(env.notifications[0][1], sentence + '\n' + SWITCH_SENTENCE + '\n' + VERSIONS_LINE, reason);
    }
});

test('the body uses the settings-less resume sentence when resume is \'file\'', () => {
    const env = install();
    load();
    env.owner._stop('start-failed', 'file');
    assert.equal(env.notifications[0][1],
        'Window Memory stopped itself for safety: it could not start.\n' + FILE_SENTENCE + '\n' + VERSIONS_LINE);
    assert.equal(readSafety(env).stopped.resume, 'file');
});

test('the texts are translated in the domain of the extension', () => {
    const env = install();
    env.translations['window-memory@bootkicker'] = { 'Window Memory': 'Fenstergedächtnis' };
    load();
    env.owner._stop('restart-loop', 'switch');
    assert.equal(env.notifications[0][0], 'Fenstergedächtnis');
});

test('a stop in the middle of a run releases everything, writes safety.json, notifies once and leaves state.json alone', () => {
    const env = install({ settings: { 'forget-focused': '<Super>f' } });
    seedState(env, [entry()]);
    load();
    const w = newWindow(env);
    env.display.emit('window-created', env.display, w);
    env.mapWindow(w);
    env.runTimers();
    const saved = fs.readFileSync(env.statePath);
    assert.ok(Object.keys(env.hotkeys).length > 0, 'the hotkey is bound while running');
    env.owner._stop('too-many-errors', 'switch');
    env.owner._stop('restart-loop', 'file'); // a second call does nothing
    assert.equal(env.notifications.length, 1);
    assert.equal(count(env.display, 'window-created'), 0);
    assert.equal(count(env.display, 'grab-op-end'), 0);
    assert.equal(count(env.wm, 'map'), 0);
    assert.deepEqual(env.hotkeys, {});
    assert.equal(env.timers.size, 0);
    assert.deepEqual(fs.readFileSync(env.statePath), saved);
    const stopped = readSafety(env).stopped;
    assert.equal(stopped.reason, 'too-many-errors');
    assert.equal(stopped.resume, 'switch');
    assert.equal(stopped.cinnamon, '6.0.5');
    assert.equal(stopped.muffin, '6.0.1');
    const w2 = newWindow(env);
    env.display.emit('window-created', env.display, w2);
    assert.deepEqual(w2.moves, []);
    assert.equal(env.errors, undefined);
});

test('_stop works when there is no settings object', () => {
    const env = install();
    load();
    env.owner._settings = null;
    assert.doesNotThrow(() => env.owner._stop('missing-call', 'file'));
    assert.equal(env.notifications.length, 1);
    assert.equal(readSafety(env).stopped.reason, 'missing-call');
    assert.doesNotThrow(() => env.owner.disable());
});

test('a changed \'enabled\' switch while stopped clears the stop, writes safety.json without stopped, and starts working', () => {
    const env = install();
    seedState(env, [entry()]);
    seedStop(env);
    load();
    env.changeSetting('enabled', false);
    assert.equal(readSafety(env).stopped, null);
    // A resume starts the work as a fresh enable() does, whatever the switch says; with the switch off the handlers do nothing.
    assert.equal(count(env.display, 'window-created'), 1);
    const w1 = newWindow(env);
    env.display.emit('window-created', env.display, w1);
    assert.deepEqual(w1.moves, []);
    env.changeSetting('enabled', true);
    assert.equal(count(env.settingsEmitter, 'changed::enabled'), 1);
    assert.equal(count(env.display, 'window-created'), 1);
    const w2 = newWindow(env);
    env.display.emit('window-created', env.display, w2);
    assert.deepEqual(w2.moves, PLACE);
    assert.equal(env.notifications.length, 0);
    assert.equal(env.errors, undefined);
});

test('turning the switch on when it was off at the stop also resumes', () => {
    const env = install({ settings: { enabled: false } });
    seedState(env, [entry()]);
    seedStop(env);
    load();
    env.changeSetting('enabled', true);
    assert.equal(readSafety(env).stopped, null);
    const w = newWindow(env);
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.moves, PLACE);
});

test('the switch resumes a stop made in the middle of a run, and only once', () => {
    const env = install({ settings: { 'forget-focused': '<Super>f' } });
    seedState(env, [entry()]);
    load();
    env.owner._stop('too-many-errors', 'switch');
    env.changeSetting('enabled', false);
    env.changeSetting('enabled', true);
    assert.equal(readSafety(env).stopped, null);
    assert.equal(count(env.display, 'window-created'), 1);
    assert.equal(count(env.settingsEmitter, 'changed::enabled'), 1);
    assert.ok(env.hotkeys['window-memory-forget-focused']);
    const w = newWindow(env);
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.moves, PLACE);
});

test('other settings do not start anything while stopped', () => {
    const env = install();
    seedState(env, [entry()]);
    seedStop(env);
    load();
    env.windows.push(newWindow(env));
    env.changeSetting('excluded-apps', []);
    env.changeSetting('include-dialogs', true);
    env.changeSetting('forget-focused', '<Super>f');
    assert.deepEqual(env.windows[0].moves, []);
    assert.deepEqual(env.hotkeys, {});
    // the same after a stop in the middle of a run
    const env2 = install();
    seedState(env2, [entry()]);
    load();
    env2.owner._stop('too-many-errors', 'switch');
    env2.windows.push(newWindow(env2));
    env2.changeSetting('excluded-apps', []);
    env2.changeSetting('forget-focused', '<Super>f');
    assert.deepEqual(env2.windows[0].moves, []);
    assert.deepEqual(env2.hotkeys, {});
});

test('disable() then a new enable() stays stopped', () => {
    const env = install();
    fs.mkdirSync(path.dirname(env.statePath), { recursive: true });
    fs.writeFileSync(env.statePath, STATE_TEXT);
    const before = fs.readFileSync(env.statePath);
    seedStop(env);
    const first = load();
    first.ext.disable();
    assert.ok(readSafety(env).stopped, 'disable() keeps the stop');
    load();
    assert.equal(count(env.display, 'window-created'), 0);
    assert.deepEqual(env.hotkeys, {});
    assert.deepEqual(env.notifications, []);
    assert.deepEqual(fs.readFileSync(env.statePath), before);
});

test('a stop made in the middle of a run is still there after disable() and a new enable()', () => {
    const env = install();
    const first = load();
    env.owner._stop('too-many-errors', 'switch');
    first.ext.disable();
    load();
    assert.equal(count(env.display, 'window-created'), 0);
    assert.equal(env.notifications.length, 1, 'the new start does not notify again');
});

test('a normal run records no stop: after a clean disable() safety.json holds no stop and no starts', () => {
    const env = install();
    seedState(env, [entry()]);
    const { ext } = load();
    ext.disable();
    assert.deepEqual(readSafety(env), { stopped: null, starts: [] });
});

test('a notification that throws or a missing Main.notify does not stop the stop', () => {
    for (const variant of ['throws', 'missing']) {
        const env = install();
        const warnings = [];
        global.logWarning = s => warnings.push(String(s));
        load();
        const Main = globalThis.imports.ui.main;
        if (variant === 'throws') Main.notify = () => { throw new Error('no notifications today'); };
        else delete Main.notify;
        assert.doesNotThrow(() => env.owner._stop('restart-loop', 'switch'), variant);
        assert.equal(readSafety(env).stopped.reason, 'restart-loop', variant);
        assert.equal(env.errors, undefined, variant);
        assert.ok(warnings.some(s => s.includes(RESTART_SENTENCE) && s.includes(VERSIONS_LINE)), variant + ': ' + warnings.join('|'));
    }
});

test('a safety.json that cannot be written does not stop anything', () => {
    const env = install();
    seedState(env, [entry()]);
    fs.mkdirSync(env.safetyPath); // a directory where the file should be: reading and writing it both fail
    const warnings = [];
    global.logWarning = s => warnings.push(String(s));
    load();
    const w = newWindow(env);
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.moves, PLACE);
    assert.equal(env.errors, undefined);
    // a stop whose record cannot be written still releases everything and notifies
    assert.doesNotThrow(() => env.owner._stop('too-many-errors', 'switch'));
    assert.equal(env.notifications.length, 1);
    assert.equal(count(env.display, 'window-created'), 0);
    assert.equal(env.errors, undefined);
    assert.ok(warnings.length > 0);
});

test('a truncated, empty or binary safety.json starts normally', () => {
    const seeds = [
        '{"stopped":{"reason":"restart-lo',
        '',
        Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x81, 0x00, 0xc3, 0x28]),
    ];
    for (const content of seeds) {
        const env = install();
        seedState(env, [entry()]);
        fs.writeFileSync(env.safetyPath, content);
        load();
        const w = newWindow(env);
        env.display.emit('window-created', env.display, w);
        assert.deepEqual(w.moves, PLACE, JSON.stringify(String(content)));
        assert.equal(env.errors, undefined);
        assert.deepEqual(env.notifications, []);
    }
});

test('the versions line says unknown for a version that cannot be read', () => {
    const env = install();
    load();
    delete globalThis.imports.misc.config;
    env.owner._stop('restart-loop', 'switch');
    assert.ok(env.notifications[0][1].endsWith('Cinnamon unknown, Muffin 6.0.1'), env.notifications[0][1]);
    assert.equal(env.errors, undefined);
});

test('the start line is logged with both versions', () => {
    for (const [opts, session] of [[{}, 'x11'], [{ wayland: true }, 'wayland']]) {
        const env = install(opts);
        const lines = [];
        global.log = s => lines.push(String(s));
        load();
        const starts = lines.filter(l => l.includes('starting:'));
        assert.deepEqual(starts, ['[window-memory] starting: Cinnamon 6.0.5, Muffin 6.0.1, session ' + session]);
        assert.equal(env.errors, undefined);
    }
});

test('a start while stopped logs the start line and nothing else is shown', () => {
    const env = install();
    seedStop(env);
    const lines = [];
    global.log = s => lines.push(String(s));
    load();
    assert.equal(lines.filter(l => l.includes('starting:')).length, 1);
    const said = lines.filter(l => l.includes('stopped ('));
    assert.equal(said.length, 1);
    assert.ok(said[0].includes('restart-loop'), said[0]);
    assert.equal(said[0], '[window-memory] stopped (restart-loop): not tracking windows; turn "Enable Window Memory" off and on to resume');
    assert.deepEqual(env.notifications, []);
});

test('the start line of a stopped start with resume \'file\' names the file to delete', () => {
    const env = install();
    seedStop(env, { reason: 'start-failed', resume: 'file' });
    const lines = [];
    global.log = s => lines.push(String(s));
    load();
    assert.deepEqual(lines.filter(l => l.includes('stopped (')),
        ['[window-memory] stopped (start-failed): not tracking windows; delete ' + env.safetyPath + ' to resume']);
});

// A start with a required member missing, a start that fails, and the optional members that may be absent.

const MISSING_SENTENCE = 'Window Memory stopped itself for safety: a function it needs is missing from this version of Cinnamon.';

test('a required member missing stops the extension at start with reason missing-call, one notification, nothing connected', () => {
    const removals = [
        ['global.window_manager', () => { global.window_manager = undefined; }],
        ['global.workspace_manager', () => { global.workspace_manager = undefined; }],
        ['global.display', () => { global.display = undefined; }],
        ['global.get_window_actors', () => { global.get_window_actors = undefined; }],
        ['Main.layoutManager', () => { globalThis.imports.ui.main.layoutManager = undefined; }],
        ['SignalManager.SignalManager', () => { globalThis.imports.misc.signalManager.SignalManager = undefined; }],
        ['Meta.MaximizeFlags', () => { globalThis.imports.gi.Meta.MaximizeFlags = undefined; }],
        ['Meta.WindowType', () => { globalThis.imports.gi.Meta.WindowType = undefined; }],
        ['Meta.Window.prototype.move_resize_frame', () => { delete globalThis.imports.gi.Meta.Window.prototype.move_resize_frame; }],
        ['Meta.Window.prototype.change_workspace', () => { delete globalThis.imports.gi.Meta.Window.prototype.change_workspace; }],
        ['Meta.Window', () => { globalThis.imports.gi.Meta.Window = undefined; }],
    ];
    for (const [name, remove] of removals) {
        const env = install();
        seedState(env, [entry()]);
        const display = env.display;
        const wm = env.wm;
        const warnings = [];
        remove();
        global.logWarning = s => warnings.push(String(s));
        env.windows.push(newWindow(env));
        assert.doesNotThrow(() => load(), name);
        assert.equal(readSafety(env).stopped.reason, 'missing-call', name);
        assert.equal(readSafety(env).stopped.resume, 'switch', name);
        assert.equal(env.notifications.length, 1, name);
        assert.equal(env.notifications[0][1], MISSING_SENTENCE + '\n' + SWITCH_SENTENCE + '\n' + VERSIONS_LINE, name);
        assert.deepEqual(display.handlers, {}, name);
        assert.deepEqual(wm.handlers, {}, name);
        assert.deepEqual(env.hotkeys, {}, name);
        assert.equal(env.timers.size, 0, name);
        assert.ok(warnings.some(s => s.includes(name)), name + ': ' + warnings.join('|'));
        assert.equal(env.errors, undefined, name);
    }
});

test('a missing required member leaves the extension watching the Enable switch, which resumes it', () => {
    const env = install();
    seedState(env, [entry()]);
    const saved = globalThis.imports.gi.Meta.MaximizeFlags;
    globalThis.imports.gi.Meta.MaximizeFlags = undefined;
    load();
    assert.equal(count(env.settingsEmitter, 'changed::enabled'), 1);
    globalThis.imports.gi.Meta.MaximizeFlags = saved; // Cinnamon was fixed
    env.changeSetting('enabled', false);
    env.changeSetting('enabled', true);
    assert.equal(readSafety(env).stopped, null);
    assert.equal(count(env.display, 'window-created'), 1);
    assert.equal(env.notifications.length, 1, 'no second notification');
});

test('a missing Settings.ExtensionSettings stops with resume \'file\' and the notification gives the deletion sentence', () => {
    const env = install();
    globalThis.imports.ui.settings.ExtensionSettings = undefined;
    assert.doesNotThrow(() => load());
    const stopped = readSafety(env).stopped;
    assert.equal(stopped.reason, 'missing-call');
    assert.equal(stopped.resume, 'file');
    assert.equal(env.notifications.length, 1);
    assert.equal(env.notifications[0][1], MISSING_SENTENCE + '\n' + FILE_SENTENCE + '\n' + VERSIONS_LINE);
    assert.deepEqual(env.display.handlers, {});
    assert.deepEqual(env.wm.handlers, {});
    assert.equal(env.errors, undefined);
});

test('a start with a stop already recorded does not check the required members or notify again', () => {
    const env = install();
    seedStop(env, { reason: 'too-many-errors' });
    globalThis.imports.gi.Meta.MaximizeFlags = undefined;
    load();
    assert.deepEqual(env.notifications, []);
    assert.equal(readSafety(env).stopped.reason, 'too-many-errors');
});

test('an exception inside enable() leaves nothing connected and stops with start-failed', () => {
    const env = install();
    seedState(env, [entry()]);
    const display = env.display;
    display.connect = () => { throw new Error('no signals today'); };
    env.windows.push(newWindow(env));
    assert.doesNotThrow(() => load());
    const stopped = readSafety(env).stopped;
    assert.equal(stopped.reason, 'start-failed');
    assert.equal(stopped.resume, 'switch');
    assert.equal(env.notifications.length, 1);
    assert.equal(env.notifications[0][1],
        'Window Memory stopped itself for safety: it could not start.\n' + SWITCH_SENTENCE + '\n' + VERSIONS_LINE);
    assert.deepEqual(display.handlers, {});
    assert.deepEqual(env.wm.handlers, {});
    assert.deepEqual(env.hotkeys, {});
    assert.equal(env.timers.size, 0);
    assert.equal(env.errors.length, 1, 'the one logError of the failed start');
    assert.match(env.errors[0], /^\[window-memory\] .*start.*no signals today/);
});

test('an exception after something was connected releases it again', () => {
    const env = install({ settings: { 'forget-focused': '<Super>f' } });
    seedState(env, [entry()]);
    env.wm.connect = () => { throw new Error('no map today'); };
    load();
    assert.equal(readSafety(env).stopped.reason, 'start-failed');
    for (const sig of ['window-created', 'grab-op-begin', 'grab-op-end']) assert.equal(count(env.display, sig), 0, sig);
    assert.deepEqual(env.hotkeys, {});
    assert.equal(env.notifications.length, 1);
});

test('a settings object that cannot be made stops with start-failed and resume \'file\'', () => {
    const env = install();
    globalThis.imports.ui.settings.ExtensionSettings = class { constructor() { throw new Error('no schema'); } };
    assert.doesNotThrow(() => load());
    const stopped = readSafety(env).stopped;
    assert.equal(stopped.reason, 'start-failed');
    assert.equal(stopped.resume, 'file');
    assert.equal(env.notifications.length, 1);
    assert.deepEqual(env.display.handlers, {});
});

test('a missing Meta.later_add skips the restore-minimized path and keeps running', () => {
    const env = install();
    const warnings = [];
    global.logWarning = s => warnings.push(String(s));
    seedState(env, [Object.assign(entry(), { minimized: true })]);
    const Meta = globalThis.imports.gi.Meta;
    Meta.later_add = undefined;
    Meta.later_remove = undefined;
    const { ext } = load();
    const w = newWindow(env);
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.moves, PLACE);
    assert.equal(w.minimized, false, 'the minimize is skipped');
    env.mapWindow(w);
    env.runTimers();
    assert.deepEqual(env.notifications, []);
    assert.equal(readSafety_or_null(env), null);
    assert.ok(warnings.some(s => s.includes('Meta.later_add')), warnings.join('|'));
    w.emit('unmanaged', w);
    ext.disable();
    assert.equal(env.errors, undefined);
});

test('with Meta.later_add there, the restore-minimized path is as before', () => {
    const env = install();
    seedState(env, [Object.assign(entry(), { minimized: true })]);
    load();
    const w = newWindow(env);
    env.display.emit('window-created', env.display, w);
    env.runLaters();
    assert.equal(w.minimized, true);
    assert.equal(env.errors, undefined);
});

function readSafety_or_null(env) {
    return fs.existsSync(env.safetyPath) ? readSafety(env).stopped : null;
}

test('a missing keybindingManager keeps running without the hotkey', () => {
    const env = install({ settings: { 'forget-focused': '<Super>f' } });
    seedState(env, [entry()]);
    const warnings = [];
    global.logWarning = s => warnings.push(String(s));
    globalThis.imports.ui.main.keybindingManager = undefined;
    const { ext } = load();
    env.changeSetting('forget-focused', '<Super>g');
    const w = newWindow(env);
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.moves, PLACE);
    assert.deepEqual(env.hotkeys, {});
    assert.equal(readSafety_or_null(env), null);
    assert.ok(warnings.some(s => s.includes('Main.keybindingManager')), warnings.join('|'));
    ext.disable();
    assert.equal(env.errors, undefined);
});

test('a missing Cinnamon.WindowTracker keeps running, and a notification names the application by its WM_CLASS', () => {
    const env = install();
    seedState(env, [entry()]);
    globalThis.imports.gi.Cinnamon.WindowTracker = undefined;
    const { callbacks, ext } = load();
    const w = newWindow(env);
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.moves, PLACE);
    env.mapWindow(w);
    env.display.focus_window = w;
    callbacks.forgetFocused();
    assert.equal(env.notifications.length, 1);
    assert.match(env.notifications[0][1], /Firefox/);
    assert.equal(readSafety_or_null(env), null);
    ext.disable();
    assert.equal(env.errors, undefined);
});

test('a missing Main.notify, pushModal or Cinnamon.Cursor keeps running and the pick fails without stopping', () => {
    const env = install();
    seedState(env, [entry()]);
    const Main = globalThis.imports.ui.main;
    delete Main.notify;
    delete Main.pushModal;
    delete Main.popModal;
    globalThis.imports.gi.Cinnamon.Cursor = undefined;
    const { callbacks, ext } = load();
    const w = newWindow(env);
    env.display.emit('window-created', env.display, w);
    assert.deepEqual(w.moves, PLACE);
    callbacks.pickWindow();
    assert.equal(env.stageInputMode, 1, 'the input is not left grabbed');
    assert.equal(readSafety_or_null(env), null);
    ext.disable();
});

test('every optional member present: no warning about optional members', () => {
    const env = install();
    const warnings = [];
    global.logWarning = s => warnings.push(String(s));
    load();
    assert.deepEqual(warnings, []);
});

// The error budget: unexpected errors in the handlers are counted, and too many in a short time stop the extension.

let theClock = null;

function controlClock(t, start) {
    const real = Date.now;
    const clock = { ms: start === undefined ? 1700000000000 : start };
    theClock = clock;
    Date.now = () => clock.ms;
    t.after(() => { Date.now = real; theClock = null; });
    return clock;
}

// A window whose class cannot be read: the window-created handler fails and logs one counted error. The clock then moves
// on by 5 seconds (ERROR_DEDUPE_SECONDS): an identical message within 5 seconds is logged but not counted.
function failOnce(env) {
    const w = newWindow(env);
    w.get_wm_class = () => { throw new Error('boom'); };
    env.display.emit('window-created', env.display, w);
    theClock.ms += 5000;
}

test('20 unexpected handler errors within 5 minutes stop the extension with reason too-many-errors', t => {
    const clock = controlClock(t);
    const env = install();
    load();
    for (let i = 0; i < 19; i++) failOnce(env);
    assert.equal(env.errors.length, 19);
    assert.equal(readSafety_or_null(env), null, 'no stop after 19 errors');
    assert.equal(env.notifications.length, 0);
    failOnce(env);
    const stopped = readSafety(env).stopped;
    assert.equal(stopped.reason, 'too-many-errors');
    assert.equal(stopped.resume, 'switch');
    assert.equal(env.notifications.length, 1);
    assert.ok(env.notifications[0][1].startsWith('Window Memory stopped itself for safety: too many errors.'));
    assert.equal(count(env.display, 'window-created'), 0);
    assert.equal(count(env.display, 'grab-op-begin'), 0);
    assert.equal(count(env.display, 'grab-op-end'), 0);
    assert.equal(count(env.wm, 'map'), 0);
    assert.equal(env.errors[0], '[window-memory] window-created handler failed: Error: boom');
});

test('19 errors then 6 minutes of quiet then more errors do not stop it', t => {
    const clock = controlClock(t);
    const env = install();
    load();
    for (let i = 0; i < 19; i++) failOnce(env);
    clock.ms += 301 * 1000;
    for (let i = 0; i < 19; i++) failOnce(env);
    assert.equal(env.errors.length, 38);
    assert.equal(readSafety_or_null(env), null);
    assert.equal(env.notifications.length, 0);
    assert.equal(count(env.display, 'window-created'), 1);
});

test('errors that are expected conditions are not counted', t => {
    controlClock(t);
    const env = install();
    seedState(env, [entry()]);
    load();
    fs.rmSync(env.statePath, { force: true });
    fs.mkdirSync(env.statePath); // a directory where the state file should be: every write fails
    for (let i = 0; i < 30; i++) env.owner._flush();
    assert.ok(env.errors.length >= 30);
    assert.ok(env.errors.every(e => e.startsWith('[window-memory] saving the state file failed: ')), env.errors[0]);
    assert.equal(readSafety_or_null(env), null);
    assert.equal(env.notifications.length, 0);
    assert.equal(count(env.display, 'window-created'), 1);
});

test('a failure of the stop itself does not escape _fail', t => {
    controlClock(t);
    const env = install();
    fs.mkdirSync(env.safetyPath, { recursive: true }); // safety.json cannot be written
    global.logWarning = () => {};
    load();
    assert.doesNotThrow(() => { for (let i = 0; i < 20; i++) failOnce(env); });
    assert.equal(env.owner._stopped, true);
    assert.equal(env.notifications.length, 1);
    assert.equal(count(env.display, 'window-created'), 0);
});

test('a _stop that throws does not escape _fail', t => {
    controlClock(t);
    const env = install();
    const warnings = [];
    global.logWarning = s => warnings.push(String(s));
    load();
    env.owner._stop = () => { throw new Error('stop broke'); };
    assert.doesNotThrow(() => { for (let i = 0; i < 20; i++) failOnce(env); });
    assert.ok(warnings.some(w => w.includes('stop broke')), warnings.join('\n'));
});

test('after a stop the same errors no longer arrive', t => {
    controlClock(t);
    const env = install();
    load();
    for (let i = 0; i < 20; i++) failOnce(env);
    assert.equal(env.notifications.length, 1);
    const logged = env.errors.length;
    failOnce(env); // no handler is connected any more
    assert.equal(env.errors.length, logged);
    // and a direct count after the stop stops nothing again and notifies nothing again
    for (let i = 0; i < 25; i++) env.owner._fail('x failed', new Error('y'));
    assert.equal(env.notifications.length, 1);
});

test('a resume starts a fresh budget', t => {
    controlClock(t);
    const env = install();
    load();
    for (let i = 0; i < 20; i++) failOnce(env);
    env.changeSetting('enabled', false); // any change of the switch resumes
    env.changeSetting('enabled', true);
    assert.equal(count(env.display, 'window-created'), 1);
    for (let i = 0; i < 19; i++) failOnce(env);
    assert.equal(env.notifications.length, 1, 'only the first stop notified');
    failOnce(env);
    assert.equal(env.notifications.length, 2, 'the 20th error of the new run stops it again');
});

// One counted error per distinct text per 5 seconds (ERROR_DEDUPE_SECONDS).

function fillDistinct(env, n) {
    for (let i = 0; i < n; i++) env.owner._fail('distinct ' + i + ' failed', new Error('e'));
}

test('a burst of identical errors within one second counts once', t => {
    controlClock(t);
    const env = install();
    load();
    for (let i = 0; i < 50; i++) env.owner._fail('size handler failed', new Error('odd window'));
    assert.equal(env.errors.length, 50, 'every one is logged');
    assert.equal(readSafety_or_null(env), null, 'but it is one count');
    fillDistinct(env, 18); // 1 + 18 = 19 counted
    assert.equal(readSafety_or_null(env), null);
    env.owner._fail('distinct 99 failed', new Error('e')); // the 20th count
    assert.equal(readSafety(env).stopped.reason, 'too-many-errors');
});

test('the same message 5 s apart counts again', t => {
    const clock = controlClock(t);
    const env = install();
    load();
    fillDistinct(env, 18);
    env.owner._fail('same failed', new Error('e')); // 19
    clock.ms += 4000;
    env.owner._fail('same failed', new Error('e')); // 4 s later: not counted
    assert.equal(readSafety_or_null(env), null);
    clock.ms += 1000;
    env.owner._fail('same failed', new Error('e')); // 5 s after the last counted one: counted, the 20th
    assert.equal(readSafety(env).stopped.reason, 'too-many-errors');
});

test('20 errors of one message spaced 5 s apart stop it', t => {
    controlClock(t);
    const env = install();
    load();
    for (let i = 0; i < 20; i++) {
        env.owner._fail('same failed', new Error('e'));
        theClock.ms += 5000;
    }
    assert.equal(readSafety(env).stopped.reason, 'too-many-errors');
    assert.equal(env.notifications.length, 1);
});

test('19 errors spaced 5 s apart do not', t => {
    controlClock(t);
    const env = install();
    load();
    for (let i = 0; i < 19; i++) {
        env.owner._fail('same failed', new Error('e'));
        theClock.ms += 5000;
    }
    assert.equal(readSafety_or_null(env), null);
    assert.equal(env.notifications.length, 0);
});

test('the dedupe memory starts empty at a resume', t => {
    controlClock(t);
    const env = install();
    load();
    env.owner._fail('same failed', new Error('e'));
    assert.ok(env.owner._failSeen.size > 0);
    env.owner._stop('too-many-errors', 'switch');
    env.changeSetting('enabled', false);
    env.changeSetting('enabled', true);
    assert.equal(env.owner._failSeen.size, 0);
});

// A stop in the middle of a loop or of a track leaves nothing tracked and nothing connected.

function allHandlers(w) {
    return Object.keys(w.handlers).reduce((n, k) => n + w.handlers[k].length, 0);
}

test('a stop in the middle of tracking the open windows leaves no window tracked or connected', t => {
    controlClock(t);
    const env = install();
    const wins = [];
    for (let i = 0; i < 25; i++) {
        const w = newWindow(env);
        if (i < 20) w.get_wm_class = () => { throw new Error('boom ' + i); }; // a distinct text each: all counted
        wins.push(w);
        env.windows.push(w);
    }
    load();
    assert.equal(readSafety(env).stopped.reason, 'too-many-errors');
    assert.equal(env.notifications.length, 1);
    wins.forEach((w, i) => assert.equal(allHandlers(w), 0, 'window ' + i));
    assert.equal(env.owner._tracked.size, 0);
    assert.equal(env.errors.length, 20, env.errors.join('\n'));
    assert.ok(!env.errors.some(e => /_saver|null/.test(e)));
    env.runTimers();
    assert.equal(env.errors.length, 20);
});

test('a stop in the middle of one track leaves nothing connected', t => {
    controlClock(t);
    const env = install();
    load();
    fillDistinct(env, 19);
    const w = newWindow(env);
    const connect = w.connect;
    w.connect = (sig, fn) => {
        if (sig === 'shown') throw new Error('no shown');
        return connect(sig, fn);
    };
    env.display.emit('window-created', env.display, w);
    assert.equal(readSafety(env).stopped.reason, 'too-many-errors');
    assert.equal(allHandlers(w), 0);
    assert.equal(env.owner._tracked.size, 0);
    assert.equal(env.notifications.length, 1);
    env.runTimers();
    assert.ok(!env.errors.some(e => /_saver|null/.test(e)), env.errors.join('\n'));
});

// The restart-loop breaker: every start is recorded in safety.json; three starts of one login session, each at most 120 s
// after the one before, stop the extension at the third.

function seedStarts(env, starts) {
    fs.mkdirSync(path.dirname(env.safetyPath), { recursive: true });
    fs.writeFileSync(env.safetyPath, Safety.serializeSafety({ stopped: null, starts: starts }));
}

function assertNothingConnected(env) {
    assert.equal(count(env.display, 'window-created'), 0);
    assert.equal(count(env.display, 'grab-op-begin'), 0);
    assert.equal(count(env.display, 'grab-op-end'), 0);
    assert.equal(count(env.wm, 'map'), 0);
    assert.deepEqual(env.hotkeys, {});
}

test('two recent unstable starts plus this one in the same session stop it', t => {
    controlClock(t, 1120 * 1000);
    const env = install({ env: { XDG_SESSION_ID: 'c2' } });
    seedState(env, [entry()]);
    seedStarts(env, [{ at: 1000, session: 'test-boot:c2' }, { at: 1060, session: 'test-boot:c2' }]);
    const w = newWindow(env);
    env.windows.push(w);
    load();
    const stopped = readSafety(env).stopped;
    assert.equal(stopped.reason, 'restart-loop');
    assert.equal(stopped.resume, 'switch');
    assert.equal(env.notifications.length, 1);
    assert.ok(env.notifications[0][1].startsWith(RESTART_SENTENCE));
    assertNothingConnected(env);
    assert.equal(env.owner._tracked.size, 0);
    assert.deepEqual(w.moves, []);
    assert.equal(env.errors, undefined);
});

test('two starts plus this one stop only when all gaps are 120 s or less', t => {
    controlClock(t, 1190 * 1000);
    const env = install({ env: { XDG_SESSION_ID: 'c2' } });
    seedStarts(env, [{ at: 1000, session: 'test-boot:c2' }, { at: 1060, session: 'test-boot:c2' }]); // the last gap is 130 s
    load();
    assert.equal(readSafety(env).stopped, null);
    assert.equal(env.notifications.length, 0);
    assert.equal(count(env.display, 'window-created'), 1);
});

test('a start in a different session does not count', t => {
    controlClock(t, 1120 * 1000);
    const env = install({ env: { XDG_SESSION_ID: 'c2' } });
    seedStarts(env, [{ at: 1000, session: 'test-boot:c2' }, { at: 1060, session: 'test-boot:c1' }]);
    load();
    assert.equal(readSafety(env).stopped, null);
    assert.equal(env.notifications.length, 0);
    assert.equal(count(env.display, 'window-created'), 1);
});

test('three restarts spaced more than 120 s apart never count', t => {
    const clock = controlClock(t, 1000 * 1000);
    const env = install({ env: { XDG_SESSION_ID: 'c2' } });
    for (let i = 0; i < 3; i++) {
        const { ext } = load();
        assert.equal(readSafety(env).stopped, null, 'start ' + i);
        assert.equal(count(env.display, 'window-created'), 1, 'start ' + i);
        // A restart is not a clean disable(): the recorded starts stay.
        env.display.handlers['window-created'] = [];
        env.wm.handlers['map'] = [];
        clock.ms += 200 * 1000;
    }
    assert.equal(env.notifications.length, 0);
    assert.equal(readSafety(env).starts.length, 3);
});

test('a clean disable() empties the recorded starts', () => {
    const env = install({ env: { XDG_SESSION_ID: 'c2' } });
    const { ext } = load();
    assert.equal(readSafety(env).starts.length, 1);
    ext.disable();
    assert.deepEqual(readSafety(env).starts, []);
});

test('without XDG_SESSION_ID the breaker uses the time rule alone', t => {
    controlClock(t, 1120 * 1000);
    const env = install();
    seedStarts(env, [{ at: 1000, session: '' }, { at: 1060, session: '' }]);
    load();
    assert.equal(readSafety(env).stopped.reason, 'restart-loop');
    assert.equal(env.notifications.length, 1);
    assertNothingConnected(env);
});

test('a normal first start writes one starts entry and no stop', t => {
    controlClock(t, 5000 * 1000);
    const env = install({ env: { XDG_SESSION_ID: 'c2' } });
    load();
    const s = readSafety(env);
    assert.equal(s.stopped, null);
    assert.deepEqual(s.starts, [{ at: 5000, session: 'test-boot:c2' }]);
    assert.deepEqual(env.notifications, []);
    assert.equal(count(env.display, 'window-created'), 1);
});

test('a safety.json that cannot be written does not prevent a normal start', () => {
    const env = install({ env: { XDG_SESSION_ID: 'c2' } });
    seedState(env, [entry()]);
    fs.mkdirSync(env.safetyPath); // a directory where the file should be: reading and writing it both fail
    const warnings = [];
    global.logWarning = s => warnings.push(String(s));
    load();
    const w = newWindow(env);
    env.display.emit('window-created', env.display, w);
    env.mapWindow(w);
    env.runTimers();
    assert.deepEqual(w.moves, PLACE);
    assert.equal(env.notifications.length, 0);
    assert.equal(env.errors, undefined);
    assert.ok(warnings.some(s => s.includes('could not write')), warnings.join('|'));
});

test('a start while a stop is recorded is recorded and does not loop-stop again', t => {
    controlClock(t, 1120 * 1000);
    const env = install({ env: { XDG_SESSION_ID: 'c2' } });
    fs.mkdirSync(path.dirname(env.safetyPath), { recursive: true });
    const stopped = Safety.stopRecord('too-many-errors', 1, '6.0.5', '6.0.1', 'switch');
    fs.writeFileSync(env.safetyPath, Safety.serializeSafety({
        stopped: stopped, starts: [{ at: 1000, session: 'test-boot:c2' }, { at: 1060, session: 'test-boot:c2' }],
    }));
    load();
    const s = readSafety(env);
    assert.equal(s.stopped.reason, 'too-many-errors');
    assert.equal(s.starts.length, 3);
    assert.deepEqual(env.notifications, []);
    assertNothingConnected(env);
});

// A resume goes through the same guarded start as enable(); an earlier stop survives a settings object
// that cannot be made; the boot id is part of the session key; the file I/O calls are required; _stop never throws.

test('resume while a required call is still missing stays stopped with nothing connected and one notification for that attempt', () => {
    const env = install({ settings: { enabled: false } });
    seedState(env, [entry()]);
    globalThis.imports.gi.Meta.MaximizeFlags = undefined;
    env.windows.push(newWindow(env));
    load();
    assert.equal(readSafety(env).stopped.reason, 'missing-call');
    assert.equal(env.notifications.length, 1);
    env.changeSetting('enabled', true); // the user tries to resume; the call is still missing
    assert.equal(env.owner._stopped, true);
    assert.equal(env.owner._working, false);
    assert.equal(readSafety(env).stopped.reason, 'missing-call');
    assert.equal(env.notifications.length, 2, 'one notification for this attempt');
    assert.equal(env.notifications[1][1], MISSING_SENTENCE + '\n' + SWITCH_SENTENCE + '\n' + VERSIONS_LINE);
    assertNothingConnected(env);
    assert.equal(env.timers.size, 0);
    assert.equal(env.owner._tracked.size, 0);
    assert.equal(count(env.settingsEmitter, 'changed::enabled'), 1);
    assert.equal(env.errors, undefined);
});

test('resume where _startWork throws leaves nothing connected and is stopped again with start-failed', () => {
    const env = install({ settings: { enabled: false, 'forget-focused': '<Super>f' } });
    seedState(env, [entry()]);
    env.wm.connect = () => { throw new Error('no map today'); }; // display signals are connected first, then this throws
    env.windows.push(newWindow(env));
    load();
    assert.equal(readSafety(env).stopped.reason, 'start-failed');
    assert.equal(env.notifications.length, 1);
    env.changeSetting('enabled', true);
    assert.equal(env.owner._stopped, true);
    assert.equal(env.owner._working, false);
    assert.equal(readSafety(env).stopped.reason, 'start-failed');
    assert.equal(readSafety(env).stopped.resume, 'switch');
    assert.equal(env.notifications.length, 2);
    assertNothingConnected(env);
    assert.equal(env.timers.size, 0);
    assert.equal(env.owner._tracked.size, 0);
    assert.equal(env.errors.length, 2, env.errors.join('\n'));
    assert.ok(env.errors.every(e => /^\[window-memory\] starting failed: .*no map today/.test(e)), env.errors.join('\n'));
});

test('a switch turned off and left off after a resume still has a working saver (forgetAll does not throw)', () => {
    const env = install();
    seedState(env, [entry()]);
    seedStop(env);
    const { callbacks } = load();
    env.changeSetting('enabled', false); // resumes; the switch stays off
    assert.doesNotThrow(() => callbacks.forgetAll());
    assert.equal(env.errors, undefined, String(env.errors));
    assert.deepEqual(JSON.parse(fs.readFileSync(env.statePath, 'utf8')).windows, []);
    // importState runs to its end as well (the staging file is read, the state written, the saver cancelled)
    const staging = path.join(path.dirname(env.statePath), 'import-pending.json');
    fs.writeFileSync(staging, JSON.stringify({ version: 1, windows: [entry()] }));
    assert.doesNotThrow(() => callbacks.importState());
    assert.equal(env.errors, undefined, String(env.errors));
});

test('a settings object that cannot be made, with a stop already recorded, keeps the record and does not notify', () => {
    const env = install({ env: { XDG_SESSION_ID: 'c2' } });
    fs.mkdirSync(path.dirname(env.safetyPath), { recursive: true });
    const stopped = Safety.stopRecord('restart-loop', 1, '6.0.5', '6.0.1', 'switch');
    fs.writeFileSync(env.safetyPath, Safety.serializeSafety({
        stopped: stopped, starts: [{ at: 1000, session: 'test-boot:c2' }, { at: 1060, session: 'test-boot:c2' }],
    }));
    const before = fs.readFileSync(env.safetyPath);
    globalThis.imports.ui.settings.ExtensionSettings = class {
        constructor(owner) { env.owner = owner; throw new Error('no schema'); }
    };
    const lines = [];
    global.log = s => lines.push(String(s));
    let callbacks;
    assert.doesNotThrow(() => { ({ callbacks } = load()); });
    assert.deepEqual(env.notifications, []);
    assert.deepEqual(fs.readFileSync(env.safetyPath), before, 'safety.json is left as it was');
    assert.equal(env.owner._stopped, true);
    assertNothingConnected(env);
    assert.equal(lines.filter(l => l.includes('stopped (restart-loop)')).length, 1, lines.join('\n'));
    assert.throws(() => callbacks.importState(), /import rejected/);
});

test('a start after a reboot (same session id, different boot id) does not count as the same session', t => {
    controlClock(t, 1120 * 1000);
    const env = install({ env: { XDG_SESSION_ID: 'c2' }, bootId: 'boot-b' });
    seedStarts(env, [{ at: 1000, session: 'boot-a:c2' }, { at: 1060, session: 'boot-a:c2' }]);
    load();
    assert.equal(readSafety(env).stopped, null);
    assert.equal(env.notifications.length, 0);
    assert.equal(count(env.display, 'window-created'), 1);
    assert.deepEqual(readSafety(env).starts.at(-1), { at: 1120, session: 'boot-b:c2' });
});

test('the session key is the boot id and the session id, and empty when both are unknown', t => {
    controlClock(t, 5000 * 1000);
    const cases = [
        [{ env: { XDG_SESSION_ID: 'c2' }, bootId: 'b1' }, 'b1:c2'],
        [{ env: { XDG_SESSION_ID: 'c2' }, bootId: null }, ':c2'],
        [{ bootId: 'b1' }, 'b1:'],
        [{ bootId: null }, ''],
    ];
    for (const [opts, key] of cases) {
        const env = install(opts);
        load();
        assert.deepEqual(readSafety(env).starts, [{ at: 5000, session: key }], JSON.stringify(opts));
    }
});

test('a missing file I/O call stops the extension at start with reason missing-call', () => {
    const removals = [
        ['imports.byteArray.toString', () => { globalThis.imports.byteArray.toString = undefined; }],
        ['Cinnamon.write_string_to_stream', () => { globalThis.imports.gi.Cinnamon.write_string_to_stream = undefined; }],
        ['Gio.BufferedOutputStream.new_sized', () => { globalThis.imports.gi.Gio.BufferedOutputStream.new_sized = undefined; }],
        ['Gio.File.new_for_path', () => { globalThis.imports.gi.Gio.File.new_for_path = undefined; }],
    ];
    for (const [name, remove] of removals) {
        const env = install();
        seedState(env, [entry()]);
        const warnings = [];
        remove();
        global.logWarning = s => warnings.push(String(s));
        env.windows.push(newWindow(env));
        assert.doesNotThrow(() => load(), name);
        assert.equal(env.owner._stopped, true, name);
        assert.equal(env.notifications.length, 1, name);
        assert.equal(env.notifications[0][1], MISSING_SENTENCE + '\n' + SWITCH_SENTENCE + '\n' + VERSIONS_LINE, name);
        // Without the write calls safety.json cannot be written; when it can, it says missing-call.
        if (fs.existsSync(env.safetyPath)) assert.equal(readSafety(env).stopped.reason, 'missing-call', name);
        assertNothingConnected(env);
        assert.ok(warnings.some(s => s.includes('required and missing: ') && s.includes(name)), name + ': ' + warnings.join('|'));
        assert.equal(env.errors, undefined, name);
    }
});

test('_stop never throws and still ends stopped when the notification, the release and the log all throw', () => {
    const env = install();
    load();
    const Main = globalThis.imports.ui.main;
    Main.notify = () => { throw new Error('no notifications today'); };
    env.owner._releaseWork = () => { throw new Error('release broke'); };
    global.logWarning = () => { throw new Error('no log today'); };
    assert.doesNotThrow(() => env.owner._stop('too-many-errors', 'switch'));
    assert.equal(env.owner._stopped, true);
    assert.doesNotThrow(() => env.owner._stop('restart-loop', 'switch'), 'still idempotent');
    // a settings object whose connect throws, at the moment the stop starts watching the switch
    const env2 = install();
    load();
    env2.owner._enabledWatched = false;
    env2.settingsEmitter.connect = () => { throw new Error('no connect today'); };
    global.logWarning = () => {};
    assert.doesNotThrow(() => env2.owner._stop('too-many-errors', 'switch'));
    assert.equal(env2.owner._stopped, true);
    assert.equal(readSafety(env2).stopped.reason, 'too-many-errors');
    assert.equal(env2.notifications.length, 1);
});
