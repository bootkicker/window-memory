// SPDX-License-Identifier: GPL-3.0-or-later
// The "Pick a window" flow in extension.js: pickWindow() starts a modal pick; pressing and releasing the primary button
// on a window adds its WM_CLASS to excluded-apps; Escape, the 20-second timeout, a click on no window or an error end
// it with no change.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { install } = require('./helpers/cinnamon-mock.js');
const { loadExtension } = require('./helpers/load-cinnamon-module.js');

const EXT = path.join(__dirname, '..', 'files', 'window-memory@bootkicker', 'extension.js');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'files', 'window-memory@bootkicker', 'settings-schema.json'), 'utf8'));
const ESCAPE = 65307; // Clutter.KEY_Escape
const CROSSHAIR = 13; // Cinnamon.Cursor.CROSSHAIR
const MIDDLE = 2; // Clutter.BUTTON_MIDDLE
const SECONDARY = 3; // Clutter.BUTTON_SECONDARY
const NORMAL_INPUT = 1; // Cinnamon.StageInputMode.NORMAL
const FULLSCREEN_INPUT = 3; // Cinnamon.StageInputMode.FULLSCREEN
const PICK_MS = 20000;
const WINDOW_TYPE = { NORMAL: 0, DIALOG: 1, DOCK: 3, DESKTOP: 4 }; // the mock's Meta.WindowType

function load() {
    const ext = loadExtension();
    ext.init({ uuid: 'window-memory@bootkicker' });
    const callbacks = ext.enable();
    return { ext, callbacks };
}

// A window the pick can see: open on the active workspace and part of the stacking order, where a window added
// later is above the ones added before it.
function addWindow(env, over) {
    const w = env.makeWindow(over);
    env.windows.push(w);
    return w;
}

function frame(x, y, w, h) {
    return { x: x, y: y, width: w, height: h };
}

// A click: the primary button goes down and comes up at the same point. Returns whether the release was swallowed.
function click(env, x, y) {
    env.sendStageEvent(env.pressEvent(x, y));
    return env.sendStageEvent(env.releaseEvent(x, y));
}

// The values written to excluded-apps, one per setValue call.
function excluded(env) {
    return env.setValueCalls.filter(c => c[0] === 'excluded-apps').map(c => c[1]);
}

// Nothing of a pick is left: no modal, the stage back to normal input, no timeout, no stage handler, the normal cursor.
function assertPickOver(env) {
    assert.deepEqual(env.modalStack, [], 'modal popped');
    assert.equal(env.modalPops, env.modalPushes, 'every push has a pop');
    assert.equal(env.endModalCalls.length, env.modalPushes, 'every grab ended');
    assert.equal(env.stageInputMode, NORMAL_INPUT, 'stage input mode back to normal');
    assert.equal(env.timers.size, 0, 'timeout cleared');
    assert.equal((env.stage.handlers['captured-event'] || []).length, 0, 'stage handler disconnected');
    assert.equal(env.cursor, null, 'cursor restored');
}

test('enable() returns pickWindow with the other callbacks, and every schema callback (button or custom widget) is there', () => {
    const env = install();
    const s = load();
    assert.deepEqual(Object.keys(s.callbacks).sort(), ['forgetAll', 'forgetFocused', 'importState', 'pickStartupWindow', 'pickWindow']);
    for (const def of Object.values(SCHEMA)) {
        if (def.callback) assert.equal(typeof s.callbacks[def.callback], 'function', def.callback);
    }
    assert.equal(env.modalStack.length, 0);
});

test('pickWindow starts a modal pick: one full-screen actor, a crosshair, a 20 second timeout, nothing changed yet', () => {
    const env = install();
    const s = load();
    s.callbacks.pickWindow();
    assert.equal(env.modalStack.length, 1);
    const actor = env.modalStack[0];
    assert.deepEqual(env.uiGroup.children, [actor]);
    assert.equal(actor.reactive, true);
    assert.equal(actor.constraints.length, 1);
    assert.equal(actor.constraints[0].source, env.stage);
    assert.equal(actor.constraints[0].coordinate, 6); // Clutter.BindCoordinate.ALL
    assert.equal(env.stage.handlers['captured-event'].length, 1);
    assert.equal(env.stageInputMode, FULLSCREEN_INPUT);
    assert.equal(env.cursor, CROSSHAIR);
    assert.deepEqual([...env.timerMs.values()], [PICK_MS]);
    assert.deepEqual(env.setValueCalls, []);
    assert.equal(env.errors, undefined);
});

test('a second pickWindow while a pick is running does nothing', () => {
    const env = install();
    const s = load();
    s.callbacks.pickWindow();
    s.callbacks.pickWindow();
    assert.equal(env.modalPushes, 1);
    assert.equal(env.modalStack.length, 1);
    assert.equal(env.timers.size, 1);
    assert.equal(env.stage.handlers['captured-event'].length, 1);
    assert.equal(env.uiGroup.children.length, 1);
});

test('a click on a window adds its WM_CLASS to excluded-apps and ends the pick', () => {
    const env = install({ settings: { 'excluded-apps': [{ wmclass: 'xed' }] } });
    const s = load();
    addWindow(env, { wmClass: 'Firefox', frame: frame(0, 0, 800, 600) });
    s.callbacks.pickWindow();
    const actor = env.modalStack[0];
    assert.equal(click(env, 100, 100), true); // the release is swallowed
    assert.deepEqual(excluded(env), [[{ wmclass: 'xed' }, { enabled: true, wmclass: 'Firefox' }]]);
    assertPickOver(env);
    assert.equal(actor.destroyed, false); // destroyed in an idle, not inside its own event
    env.runIdles();
    assert.equal(actor.destroyed, true);
    assert.deepEqual(env.uiGroup.children, []);
    assert.equal(env.errors, undefined);
});

test('the pick ends when the button is released, not when it goes down', () => {
    const env = install();
    const s = load();
    addWindow(env, { wmClass: 'Firefox', frame: frame(0, 0, 800, 600) });
    s.callbacks.pickWindow();
    assert.equal(env.sendStageEvent(env.pressEvent(100, 100)), true);
    assert.deepEqual(env.setValueCalls, []);
    assert.equal(env.modalStack.length, 1);
    assert.equal(env.timers.size, 1);
    assert.equal(env.stage.handlers['captured-event'].length, 1);
    assert.equal(env.sendStageEvent(env.releaseEvent(100, 100)), true);
    assert.deepEqual(excluded(env), [[{ enabled: true, wmclass: 'Firefox' }]]);
    assertPickOver(env);
    assert.equal(env.errors, undefined);
});

test('a press with no release does not end the pick; the timeout does, with no change', () => {
    const env = install();
    const s = load();
    addWindow(env, { wmClass: 'Firefox', frame: frame(0, 0, 800, 600) });
    s.callbacks.pickWindow();
    env.sendStageEvent(env.pressEvent(100, 100));
    assert.equal(env.modalStack.length, 1);
    assert.deepEqual(env.setValueCalls, []);
    env.runTimers();
    assert.deepEqual(env.setValueCalls, []);
    assertPickOver(env);
    assert.equal(env.errors, undefined);
});

test('the window under the press is the one picked, wherever the button is released', () => {
    const env = install();
    const s = load();
    addWindow(env, { wmClass: 'Left', frame: frame(0, 0, 500, 500) });
    addWindow(env, { wmClass: 'Right', frame: frame(600, 0, 500, 500) });
    s.callbacks.pickWindow();
    env.sendStageEvent(env.pressEvent(100, 100));
    env.sendStageEvent(env.releaseEvent(700, 100)); // dragged over the other window
    assert.deepEqual(excluded(env), [[{ enabled: true, wmclass: 'Left' }]]);
    assertPickOver(env);
    s.callbacks.pickWindow();
    env.sendStageEvent(env.pressEvent(700, 100));
    env.sendStageEvent(env.releaseEvent(1500, 900)); // dragged off every window
    assert.deepEqual(excluded(env)[1], [{ enabled: true, wmclass: 'Left' }, { enabled: true, wmclass: 'Right' }]);
    assertPickOver(env);
});

test('the middle button does nothing: press and release are swallowed and the pick goes on', () => {
    const env = install();
    const s = load();
    addWindow(env, { wmClass: 'Firefox', frame: frame(0, 0, 800, 600) });
    s.callbacks.pickWindow();
    assert.equal(env.sendStageEvent(env.pressEvent(100, 100, MIDDLE)), true);
    assert.equal(env.sendStageEvent(env.releaseEvent(100, 100, MIDDLE)), true);
    assert.equal(env.modalStack.length, 1);
    assert.equal(env.timers.size, 1);
    assert.deepEqual(env.setValueCalls, []);
    assert.equal(click(env, 100, 100), true); // then the primary button still works
    assert.deepEqual(excluded(env), [[{ enabled: true, wmclass: 'Firefox' }]]);
    assertPickOver(env);
    assert.equal(env.errors, undefined);
});

test('a release of another button does not end a primary press, and a release with no press is ignored', () => {
    const env = install();
    const s = load();
    addWindow(env, { wmClass: 'Firefox', frame: frame(0, 0, 800, 600) });
    s.callbacks.pickWindow();
    assert.equal(env.sendStageEvent(env.releaseEvent(100, 100)), true); // no press before it
    assert.equal(env.modalStack.length, 1);
    assert.deepEqual(env.setValueCalls, []);
    env.sendStageEvent(env.pressEvent(100, 100, MIDDLE)); // a middle press is no press of the primary button
    env.sendStageEvent(env.releaseEvent(100, 100));
    assert.equal(env.modalStack.length, 1);
    assert.deepEqual(env.setValueCalls, []);
    env.sendStageEvent(env.pressEvent(100, 100));
    env.sendStageEvent(env.releaseEvent(100, 100, MIDDLE));
    assert.equal(env.modalStack.length, 1);
    assert.deepEqual(env.setValueCalls, []);
    env.sendStageEvent(env.releaseEvent(100, 100));
    assert.deepEqual(excluded(env), [[{ enabled: true, wmclass: 'Firefox' }]]);
    assertPickOver(env);
});

test('the click picks the topmost window at that point', () => {
    const env = install();
    const s = load();
    addWindow(env, { wmClass: 'Below', frame: frame(0, 0, 1000, 800) });
    addWindow(env, { wmClass: 'Above', frame: frame(500, 400, 400, 300) });
    s.callbacks.pickWindow();
    click(env, 600, 500); // inside both: the later one is on top
    assert.deepEqual(excluded(env), [[{ enabled: true, wmclass: 'Above' }]]);
    s.callbacks.pickWindow();
    click(env, 100, 100); // inside the lower window only
    assert.deepEqual(excluded(env), [[{ enabled: true, wmclass: 'Above' }], [{ enabled: true, wmclass: 'Above' }, { enabled: true, wmclass: 'Below' }]]);
    assertPickOver(env);
});

test('a desktop, dock, dialog, menu, class-less window or pop-up over the click blocks the pick: the window below is not picked', () => {
    const kinds = [
        { name: 'desktop', over: { wmClass: 'Nemo', type: WINDOW_TYPE.DESKTOP } },
        { name: 'dock', over: { wmClass: 'Plank', type: WINDOW_TYPE.DOCK } },
        { name: 'file dialog', over: { wmClass: 'Gnome-terminal', type: WINDOW_TYPE.DIALOG } },
        { name: 'menu (override-redirect)', over: { wmClass: 'Gnome-terminal' }, redirect: true },
        { name: 'window with no class', over: { wmClass: '' } },
        { name: 'pop-up', over: { wmClass: 'Gnome-terminal', role: 'pop-up' } },
    ];
    for (const kind of kinds) {
        const env = install();
        const s = load();
        addWindow(env, { wmClass: 'Gnome-terminal', frame: frame(0, 0, 1000, 800) });
        const cover = addWindow(env, Object.assign({ frame: frame(100, 100, 300, 300) }, kind.over));
        if (kind.redirect) cover.is_override_redirect = () => true;
        s.callbacks.pickWindow();
        click(env, 150, 150);
        assert.deepEqual(env.setValueCalls, [], kind.name);
        assertPickOver(env);
        s.callbacks.pickWindow();
        click(env, 800, 600); // beside the cover: the terminal itself
        assert.deepEqual(excluded(env), [[{ enabled: true, wmclass: 'Gnome-terminal' }]], kind.name);
        assert.equal(env.errors, undefined, kind.name);
    }
});

test('a minimized window and a window on another workspace are not in the way: the window under them is picked', () => {
    const env = install();
    const s = load();
    addWindow(env, { wmClass: 'Base', frame: frame(0, 0, 1000, 800) });
    const covers = frame(0, 0, 1000, 800);
    addWindow(env, { wmClass: 'MinimizedWin', showing: false, frame: covers });
    addWindow(env, { wmClass: 'ElsewhereWin', workspace: 1, frame: covers });
    s.callbacks.pickWindow();
    click(env, 100, 100);
    assert.deepEqual(excluded(env), [[{ enabled: true, wmclass: 'Base' }]]);
    assertPickOver(env);
    assert.equal(env.errors, undefined);
});

test('a window shown on every workspace is picked, whatever workspace it reports', () => {
    const env = install();
    const s = load();
    const sticky = addWindow(env, { wmClass: 'Sticky', workspace: 1, frame: frame(0, 0, 500, 500) });
    sticky.is_on_all_workspaces = () => true;
    const noWorkspace = addWindow(env, { wmClass: 'NoWorkspace', frame: frame(600, 0, 500, 500) });
    noWorkspace.is_on_all_workspaces = () => true;
    noWorkspace.get_workspace = () => null;
    s.callbacks.pickWindow();
    click(env, 10, 10);
    s.callbacks.pickWindow();
    click(env, 610, 10);
    assert.deepEqual(excluded(env)[1], [{ enabled: true, wmclass: 'Sticky' }, { enabled: true, wmclass: 'NoWorkspace' }]);
    assert.equal(env.errors, undefined);
});

test('a class that is already in the list, in any case, is not added twice and nothing is written', () => {
    const env = install({ settings: { 'excluded-apps': [{ wmclass: ' FIREFOX ' }] } });
    const s = load();
    addWindow(env, { wmClass: 'Firefox', frame: frame(0, 0, 800, 600) });
    s.callbacks.pickWindow();
    click(env, 100, 100);
    assert.deepEqual(env.setValueCalls, []);
    assertPickOver(env);
});

test('a row that is part of the class already covers it, as it does for the exclusion: nothing is written', () => {
    const env = install({ settings: { 'excluded-apps': [{ wmclass: 'fire' }] } });
    const s = load();
    addWindow(env, { wmClass: 'Firefox', frame: frame(0, 0, 800, 600) });
    s.callbacks.pickWindow();
    click(env, 100, 100);
    assert.deepEqual(env.setValueCalls, []);
    assertPickOver(env);
});

test('adding a class keeps every existing row as it was and appends one new row', () => {
    const rows = [{ wmclass: '' }, { wmclass: 'xed' }, { wmclass: 'Xed', note: 1 }, { wmclass: '  ' }];
    const env = install({ settings: { 'excluded-apps': rows } });
    const s = load();
    addWindow(env, { wmClass: 'Firefox', frame: frame(0, 0, 800, 600) });
    s.callbacks.pickWindow();
    click(env, 100, 100);
    assert.equal(excluded(env).length, 1);
    const written = excluded(env)[0];
    assert.deepEqual(written, [{ wmclass: '' }, { wmclass: 'xed' }, { wmclass: 'Xed', note: 1 }, { wmclass: '  ' }, { enabled: true, wmclass: 'Firefox' }]);
    rows.forEach((row, i) => assert.equal(written[i], row)); // the very same row objects
    assert.equal(rows.length, 4); // the stored list was not changed in place
});

test('picking a window whose row is unchecked checks that row again: no second row, the other rows the same objects', () => {
    const xed = { enabled: true, wmclass: 'xed' };
    const off = { enabled: false, wmclass: 'firefox' };
    const env = install({ settings: { 'excluded-apps': [xed, off] } });
    const s = load();
    addWindow(env, { wmClass: 'Firefox', frame: frame(0, 0, 800, 600) });
    s.callbacks.pickWindow();
    click(env, 100, 100);
    assert.deepEqual(excluded(env), [[{ enabled: true, wmclass: 'xed' }, { enabled: true, wmclass: 'firefox' }]]);
    assert.equal(excluded(env)[0][0], xed);
    assert.equal(off.enabled, false, 'the stored row is not changed in place');
    assertPickOver(env);
    assert.equal(env.errors, undefined);
});

test('an unchecked row that is only part of the class does not cover it: a checked row is appended', () => {
    const env = install({ settings: { 'excluded-apps': [{ enabled: false, wmclass: 'fire' }] } });
    const s = load();
    addWindow(env, { wmClass: 'Firefox', frame: frame(0, 0, 800, 600) });
    s.callbacks.pickWindow();
    click(env, 100, 100);
    assert.deepEqual(excluded(env), [[{ enabled: false, wmclass: 'fire' }, { enabled: true, wmclass: 'Firefox' }]]);
});

test('Escape cancels the pick with no change, and the timeout is cleared', () => {
    const env = install();
    const s = load();
    addWindow(env, { wmClass: 'Firefox', frame: frame(0, 0, 800, 600) });
    s.callbacks.pickWindow();
    assert.equal(env.sendStageEvent(env.keyEvent(ESCAPE)), true);
    assert.deepEqual(env.setValueCalls, []);
    assertPickOver(env);
    assert.equal(env.removedSources.length, 1); // the pick's own timeout
    assert.equal(env.errors, undefined);
});

// Main connects its own captured-event handler first, so it runs before ours and may still trigger a keybinding
// (ui/main.js:445, 1119-1138). Ours stops the event (Clutter.EVENT_STOP), which keeps the key from the windows.
// A mouse move is swallowed as well: it only moves the highlight, and nothing under the modal grab needs it.
test('another key or a mouse move does not end the pick and stays away from the windows', () => {
    const env = install();
    const s = load();
    s.callbacks.pickWindow();
    assert.equal(env.sendStageEvent(env.keyEvent(97)), true);
    assert.equal(env.sendStageEvent(env.motionEvent(50, 50)), true);
    assert.equal(env.modalStack.length, 1);
    assert.equal(env.timers.size, 1);
    assert.deepEqual(env.setValueCalls, []);
});

test('the 20 second timeout cancels the pick with no change and does not clear a timer that already ran', () => {
    const env = install();
    const s = load();
    addWindow(env, { wmClass: 'Firefox', frame: frame(0, 0, 800, 600) });
    s.callbacks.pickWindow();
    env.runTimers();
    assert.deepEqual(env.setValueCalls, []);
    assertPickOver(env);
    assert.deepEqual(env.removedSources, []);
    assert.equal(env.sendStageEvent(env.pressEvent(100, 100)), false); // the pick is over: a click is nobody's business
    assert.equal(env.sendStageEvent(env.releaseEvent(100, 100)), false);
    assert.deepEqual(env.setValueCalls, []);
    assert.equal(env.errors, undefined);
});

test('a click that hits no window cancels the pick with no change', () => {
    const env = install();
    const s = load();
    addWindow(env, { wmClass: 'Firefox', frame: frame(0, 0, 800, 600) });
    s.callbacks.pickWindow();
    assert.equal(click(env, 1500, 900), true);
    assert.deepEqual(env.setValueCalls, []);
    assertPickOver(env);
    assert.equal(env.errors, undefined);
});

test('an error while looking for the window ends the pick: modal popped, timeout cleared, error logged', () => {
    const env = install();
    const s = load();
    s.callbacks.pickWindow();
    global.get_window_actors = () => { throw new Error('actors boom'); }; // after the start: the press lists the windows again
    env.sendStageEvent(env.pressEvent(100, 100));
    assertPickOver(env);
    assert.deepEqual(env.setValueCalls, []);
    assert.equal(env.errors.length, 1);
    assert.match(env.errors[0], /actors boom/);
});

test('an error while saving the setting ends the pick the same way', () => {
    const env = install();
    const s = load();
    addWindow(env, { wmClass: 'Firefox', frame: frame(0, 0, 800, 600) });
    globalThis.imports.ui.settings.ExtensionSettings.prototype.setValue = () => { throw new Error('disk boom'); };
    s.callbacks.pickWindow();
    click(env, 100, 100);
    assertPickOver(env);
    assert.equal(env.errors.length, 1);
    assert.match(env.errors[0], /disk boom/);
});

test('an event that is not what the pick expects does not escape the handler', () => {
    const env = install();
    const s = load();
    s.callbacks.pickWindow();
    const broken = { type: () => { throw new Error('event boom'); } };
    assert.doesNotThrow(() => env.sendStageEvent(broken));
    assertPickOver(env);
    assert.match(env.errors[0], /event boom/);
});

test('if popModal fails, the timeout, the stage handler and the cursor are still released and a new pick can start', () => {
    const env = install();
    const s = load();
    addWindow(env, { wmClass: 'Firefox', frame: frame(0, 0, 800, 600) });
    const main = globalThis.imports.ui.main;
    const realPop = main.popModal;
    main.popModal = () => { throw new Error('incorrect pop'); };
    s.callbacks.pickWindow();
    click(env, 100, 100);
    assert.equal(env.timers.size, 0);
    assert.equal(env.stage.handlers['captured-event'].length, 0);
    assert.equal(env.cursor, null);
    assert.deepEqual(excluded(env), [[{ enabled: true, wmclass: 'Firefox' }]]); // the pick itself had worked
    assert.match(env.errors[0], /incorrect pop/);
    assert.deepEqual(env.endModalCalls, []); // the modal count is not 0: the grab is not ours to end
    main.popModal = realPop;
    env.modalStack.length = 0;
    s.callbacks.pickWindow();
    assert.equal(env.modalStack.length, 1);
});

test('if popModal fails after taking the modal off the stack, the grab is ended and the input mode reset here', () => {
    const env = install();
    const s = load();
    const main = globalThis.imports.ui.main;
    main.popModal = actor => {
        env.modalStack.splice(env.modalStack.indexOf(actor), 1);
        throw new Error('pop boom');
    };
    s.callbacks.pickWindow();
    env.sendStageEvent(env.keyEvent(ESCAPE));
    assert.deepEqual(env.endModalCalls, [1234567]); // global.get_current_time()
    assert.equal(env.stageInputMode, NORMAL_INPUT);
    assert.equal(env.timers.size, 0);
    assert.equal(env.cursor, null);
    assert.equal(env.stage.handlers['captured-event'].length, 0);
    assert.equal(env.errors.length, 1);
    assert.match(env.errors[0], /pop boom/);
});

test('if popModal fails while another modal is still up, that grab is left alone', () => {
    const env = install();
    const s = load();
    const main = globalThis.imports.ui.main;
    const other = {};
    main.pushModal(other);
    const realPop = main.popModal;
    main.popModal = () => { throw new Error('pop boom'); };
    s.callbacks.pickWindow();
    env.sendStageEvent(env.keyEvent(ESCAPE));
    assert.deepEqual(env.endModalCalls, []);
    assert.equal(env.stageInputMode, FULLSCREEN_INPUT);
    assert.equal(env.errors.length, 1);
    main.popModal = realPop;
});

test('if ending the grab itself fails, the input mode is still reset, and nothing escapes the handler', () => {
    const env = install();
    const s = load();
    const main = globalThis.imports.ui.main;
    main.popModal = actor => {
        env.modalStack.splice(env.modalStack.indexOf(actor), 1);
        throw new Error('pop boom');
    };
    global.end_modal = () => { throw new Error('end boom'); };
    s.callbacks.pickWindow();
    assert.doesNotThrow(() => env.sendStageEvent(env.keyEvent(ESCAPE)));
    assert.equal(env.stageInputMode, NORMAL_INPUT);
    assert.equal(env.timers.size, 0);
    assert.equal(env.errors.length, 2);
    assert.match(env.errors[0], /end boom/);
    assert.match(env.errors[1], /pop boom/);
});

test('if the input grab is refused, no pick starts, nothing is left behind, and a later pick works', () => {
    const env = install();
    const s = load();
    env.grabFails = true;
    s.callbacks.pickWindow();
    assert.equal(env.modalPushes, 0);
    assertPickOver(env);
    assert.deepEqual(env.uiGroup.children, []); // the actor was removed again
    assert.equal(env.errors, undefined);
    env.grabFails = false;
    s.callbacks.pickWindow();
    assert.equal(env.modalStack.length, 1);
    assert.equal(env.timers.size, 1);
});

test('a pick can start again after one ended, whichever way it ended', () => {
    const env = install();
    const s = load();
    addWindow(env, { wmClass: 'Firefox', frame: frame(0, 0, 800, 600) });
    s.callbacks.pickWindow();
    env.sendStageEvent(env.keyEvent(ESCAPE));
    s.callbacks.pickWindow();
    env.runTimers();
    s.callbacks.pickWindow();
    click(env, 100, 100);
    assertPickOver(env);
    assert.equal(env.modalPushes, 3);
    assert.deepEqual(excluded(env), [[{ enabled: true, wmclass: 'Firefox' }]]);
});

test('disabling the extension during a pick ends it: modal popped, timeout cleared, no change later', () => {
    const env = install();
    const s = load();
    addWindow(env, { wmClass: 'Firefox', frame: frame(0, 0, 800, 600) });
    s.callbacks.pickWindow();
    s.ext.disable();
    assertPickOver(env);
    assert.equal(env.sendStageEvent(env.pressEvent(100, 100)), false);
    assert.equal(env.sendStageEvent(env.releaseEvent(100, 100)), false);
    assert.deepEqual(env.setValueCalls, []);
    assert.equal(env.errors, undefined);
});

test('disabling the extension between the press and the release ends the pick with no change', () => {
    const env = install();
    const s = load();
    addWindow(env, { wmClass: 'Firefox', frame: frame(0, 0, 800, 600) });
    s.callbacks.pickWindow();
    env.sendStageEvent(env.pressEvent(100, 100));
    s.ext.disable();
    assertPickOver(env);
    assert.equal(env.sendStageEvent(env.releaseEvent(100, 100)), false);
    assert.deepEqual(env.setValueCalls, []);
    assert.equal(env.errors, undefined);
});

test('a window that was picked is not saved any more, though setValue sends no changed signal', () => {
    const env = install();
    const s = load();
    const w = env.makeWindow({ wmClass: 'Firefox', frame: frame(0, 0, 800, 600) });
    env.windows.push(w);
    env.display.emit('window-created', env.display, w);
    env.mapWindow(w);
    w.frame = frame(10, 10, 700, 500);
    env.display.emit('grab-op-end', env.display, w);
    env.runTimers();
    assert.deepEqual(JSON.parse(fs.readFileSync(env.statePath, 'utf8')).windows[0].rel, { x: 10, y: 10, w: 700, h: 500 });

    s.callbacks.pickWindow();
    click(env, 100, 100);
    w.frame = frame(300, 200, 900, 700);
    env.display.emit('grab-op-end', env.display, w);
    w.emit('unmanaging', w);
    env.runTimers();
    assert.deepEqual(JSON.parse(fs.readFileSync(env.statePath, 'utf8')).windows[0].rel, { x: 10, y: 10, w: 700, h: 500 });
    assert.equal(env.errors, undefined);
});

// The pick overlay: a hint at the top of the primary monitor, and a highlight with the WM_CLASS over the window under the
// pointer. All of it lives inside the pick's full-stage actor, so it goes with that actor.
const HINT_EXCLUDE = 'Click a window to never remember its application.  Esc or right-click to cancel.';
const HINT_STYLE = 'background-color: rgba(255,113,57,0.75); color: #353535; padding: 10px 18px; border-radius: 8px; font-size: 11pt;';
const HIGHLIGHT_STYLE = 'border: 2px solid rgba(0,205,205,1); background-color: rgba(0,205,205,0.16); border-radius: 6px;';
const NAME_STYLE = 'background-color: rgba(255,113,57,0.75); color: #353535; padding: 4px 10px; border-radius: 4px; font-weight: bold;';

// The overlay of the running pick: {actor, highlight, name, hint}.
function overlay(env) {
    const actor = env.modalStack[env.modalStack.length - 1];
    const [highlight, hint] = actor.children;
    return { actor: actor, highlight: highlight, name: highlight.children[0], hint: hint };
}

// Every actor of the overlay, the pick actor first.
function overlayActors(o) {
    return [o.actor, o.highlight, o.name, o.hint];
}

test('the pick shows a hint centred near the top of the primary monitor and a hidden highlight holding a name label', () => {
    const monitors = [{ x: 0, y: 0, width: 1280, height: 1024 }, { x: 1280, y: 100, width: 1920, height: 1080 }];
    const env = install({ monitors: monitors });
    globalThis.imports.ui.main.layoutManager.primaryIndex = 1;
    globalThis.imports.ui.main.layoutManager.primaryMonitor = monitors[1];
    const s = load();
    s.callbacks.pickWindow();
    const o = overlay(env);
    assert.equal(o.actor.children.length, 2);
    assert.equal(o.hint.text, HINT_EXCLUDE);
    assert.equal(o.hint.style, HINT_STYLE);
    const width = HINT_EXCLUDE.length * 7; // the mock label's natural width
    assert.deepEqual([o.hint.x, o.hint.y], [1280 + Math.floor((1920 - width) / 2), 100 + 60]);
    assert.equal(o.hint.visible, true);
    assert.equal(o.highlight.visible, false);
    assert.equal(o.highlight.style, HIGHLIGHT_STYLE);
    assert.equal(o.highlight.children.length, 1);
    assert.deepEqual([o.name.x, o.name.y], [10, 10]);
    assert.equal(o.name.style, NAME_STYLE);
    assert.deepEqual(env.uiGroup.children, [o.actor]); // nothing outside the pick actor
    assert.deepEqual([...env.timerMs.values()], [PICK_MS]); // no timer of its own
    assert.equal(env.errors, undefined);
});

test('the hint is translated in the extension\'s domain', () => {
    const env = install();
    env.translations['window-memory@bootkicker'] = { [HINT_EXCLUDE]: 'Klik op een venster.' };
    const s = load();
    s.callbacks.pickWindow();
    assert.equal(overlay(env).hint.text, 'Klik op een venster.');
});

test('the highlight follows the pointer over windows that can be picked, names the WM_CLASS, and hides elsewhere', () => {
    const env = install();
    const s = load();
    addWindow(env, { wmClass: 'Left', frame: frame(0, 0, 500, 500) });
    addWindow(env, { wmClass: 'Right', frame: frame(600, 0, 500, 400) });
    addWindow(env, { wmClass: 'Gedit', type: WINDOW_TYPE.DIALOG, frame: frame(700, 100, 100, 100) });
    s.callbacks.pickWindow();
    const o = overlay(env);
    assert.equal(env.sendStageEvent(env.motionEvent(100, 100)), true);
    assert.equal(o.highlight.visible, true);
    assert.deepEqual([o.highlight.x, o.highlight.y, o.highlight.width, o.highlight.height], [0, 0, 500, 500]);
    assert.equal(o.name.text, 'Left');
    env.sendStageEvent(env.motionEvent(650, 50));
    assert.deepEqual([o.highlight.x, o.highlight.y, o.highlight.width, o.highlight.height], [600, 0, 500, 400]);
    assert.equal(o.name.text, 'Right');
    assert.equal(o.highlight.visible, true);
    env.sendStageEvent(env.motionEvent(750, 150)); // the dialog on top cannot be picked
    assert.equal(o.highlight.visible, false);
    env.sendStageEvent(env.motionEvent(650, 50));
    assert.equal(o.highlight.visible, true);
    env.sendStageEvent(env.motionEvent(1500, 900)); // the desktop: no window
    assert.equal(o.highlight.visible, false);
    assert.equal(env.modalStack.length, 1);
    assert.deepEqual(env.setValueCalls, []);
    assert.equal(env.errors, undefined);
});

test('the highlight is only redrawn when the window under the pointer changes, and the windows are listed once for it', () => {
    const env = install();
    const s = load();
    addWindow(env, { wmClass: 'Firefox', frame: frame(0, 0, 800, 600) });
    const listed = env.windowListings; // enable() lists the open windows too
    s.callbacks.pickWindow();
    assert.equal(env.windowListings, listed + 1, 'listed once at the start');
    env.sendStageEvent(env.motionEvent(100, 100));
    const after = Object.assign({}, env.widgetCalls);
    for (let i = 0; i < 20; i++) env.sendStageEvent(env.motionEvent(100 + i, 200));
    assert.deepEqual(env.widgetCalls, after, 'no redraw while the pointer stays over the same window');
    env.sendStageEvent(env.motionEvent(1500, 900));
    env.sendStageEvent(env.motionEvent(1600, 950));
    assert.equal(env.widgetCalls.hide, after.hide + 1, 'hidden once');
    assert.equal(env.windowListings, listed + 1, 'motion does not list the windows again');
    click(env, 100, 100);
    assert.equal(env.windowListings, listed + 2, 'the press lists them afresh');
    assert.deepEqual(excluded(env), [[{ enabled: true, wmclass: 'Firefox' }]]);
});

test('the window under the pointer when the pick starts is highlighted at once', () => {
    const env = install();
    const s = load();
    addWindow(env, { wmClass: 'Firefox', frame: frame(0, 0, 800, 600) });
    env.pointer = [100, 100];
    s.callbacks.pickWindow();
    const o = overlay(env);
    assert.equal(o.highlight.visible, true);
    assert.equal(o.name.text, 'Firefox');
    assert.deepEqual([o.highlight.width, o.highlight.height], [800, 600]);
});

test('the press picks from a fresh list of windows, not from the one the highlight uses', () => {
    const env = install();
    const s = load();
    addWindow(env, { wmClass: 'Firefox', frame: frame(0, 0, 800, 600) });
    s.callbacks.pickWindow();
    env.sendStageEvent(env.motionEvent(100, 100));
    addWindow(env, { wmClass: 'Newer', frame: frame(0, 0, 400, 400) }); // opened on top during the pick
    click(env, 100, 100);
    assert.deepEqual(excluded(env), [[{ enabled: true, wmclass: 'Newer' }]]);
});

test('a right-click cancels the pick on the release, with no change, and gives the input back', () => {
    const env = install();
    const s = load();
    addWindow(env, { wmClass: 'Firefox', frame: frame(0, 0, 800, 600) });
    s.callbacks.pickWindow();
    assert.equal(env.sendStageEvent(env.pressEvent(100, 100, SECONDARY)), true);
    assert.equal(env.modalStack.length, 1, 'the press only is swallowed');
    assert.equal(env.timers.size, 1);
    assert.equal(env.sendStageEvent(env.releaseEvent(100, 100, SECONDARY)), true);
    assert.deepEqual(env.setValueCalls, []);
    assertPickOver(env);
    assert.equal(env.removedSources.length, 1); // the pick's own timeout
    assert.equal(env.errors, undefined);
});

test('a right-click release after a primary press still cancels with no change', () => {
    const env = install();
    const s = load();
    addWindow(env, { wmClass: 'Firefox', frame: frame(0, 0, 800, 600) });
    s.callbacks.pickWindow();
    env.sendStageEvent(env.pressEvent(100, 100));
    env.sendStageEvent(env.releaseEvent(100, 100, SECONDARY));
    assert.deepEqual(env.setValueCalls, []);
    assertPickOver(env);
});

test('the overlay is gone after every way a pick ends', () => {
    const ways = {
        'a click': env => click(env, 100, 100),
        'a click on no window': env => click(env, 1500, 900),
        'Escape': env => env.sendStageEvent(env.keyEvent(ESCAPE)),
        'a right-click': env => {
            env.sendStageEvent(env.pressEvent(100, 100, SECONDARY));
            env.sendStageEvent(env.releaseEvent(100, 100, SECONDARY));
        },
        'the timeout': env => env.runTimers(),
        'an error': env => env.sendStageEvent({ type: () => { throw new Error('event boom'); } }),
        'disabling the extension': (env, s) => s.ext.disable(),
    };
    for (const [name, end] of Object.entries(ways)) {
        const env = install();
        const s = load();
        addWindow(env, { wmClass: 'Firefox', frame: frame(0, 0, 800, 600) });
        s.callbacks.pickWindow();
        env.sendStageEvent(env.motionEvent(100, 100));
        const o = overlay(env);
        end(env, s);
        assertPickOver(env);
        env.runIdles();
        overlayActors(o).forEach((a, i) => assert.equal(a.destroyed, true, name + ': actor ' + i));
        assert.deepEqual(env.uiGroup.children, [], name);
        assert.equal(env.sendStageEvent(env.motionEvent(120, 120)), false, name + ': a move after the end is nobody\'s business');
    }
});

test('a failure while building the overlay does not stop the pick: it is logged and the click still works', () => {
    for (const broken of ['Label', 'get_preferred_width', 'set_position']) {
        const env = install();
        const s = load();
        addWindow(env, { wmClass: 'Firefox', frame: frame(0, 0, 800, 600) });
        env.actorFails[broken] = true;
        s.callbacks.pickWindow();
        assert.equal(env.modalStack.length, 1, broken);
        assert.equal(env.timers.size, 1, broken);
        assert.equal(env.cursor, CROSSHAIR, broken);
        assert.equal(env.errors.length, 1, broken);
        assert.match(env.errors[0], /overlay/, broken);
        assert.deepEqual(env.modalStack[0].children, [], broken + ': no half-built overlay is left on the screen');
        assert.equal(env.sendStageEvent(env.motionEvent(100, 100)), true, broken);
        assert.equal(env.errors.length, 1, broken + ': no error for each move');
        click(env, 100, 100);
        assert.deepEqual(excluded(env), [[{ enabled: true, wmclass: 'Firefox' }]], broken);
        assertPickOver(env);
        env.runIdles();
        assert.deepEqual(env.uiGroup.children, [], broken);
    }
});

test('a failure while moving the highlight is logged once; the pick goes on and the click still works', () => {
    const env = install();
    const s = load();
    addWindow(env, { wmClass: 'Firefox', frame: frame(0, 0, 800, 600) });
    s.callbacks.pickWindow();
    env.actorFails.set_size = true;
    assert.equal(env.sendStageEvent(env.motionEvent(100, 100)), true);
    assert.equal(env.errors.length, 1);
    assert.match(env.errors[0], /set_size boom/);
    env.sendStageEvent(env.motionEvent(1500, 900));
    env.sendStageEvent(env.motionEvent(100, 100));
    assert.equal(env.errors.length, 1);
    assert.equal(env.modalStack.length, 1);
    click(env, 100, 100);
    assert.deepEqual(excluded(env), [[{ enabled: true, wmclass: 'Firefox' }]]);
    assertPickOver(env);
});

test('a failure while listing the windows at the start leaves no highlight, and the pick goes on', () => {
    const env = install();
    const s = load();
    addWindow(env, { wmClass: 'Firefox', frame: frame(0, 0, 800, 600) });
    const real = global.get_window_actors;
    global.get_window_actors = () => { throw new Error('actors boom'); };
    s.callbacks.pickWindow();
    global.get_window_actors = real;
    assert.equal(env.modalStack.length, 1);
    assert.equal(env.errors.length, 1);
    assert.match(env.errors[0], /actors boom/);
    const o = overlay(env);
    assert.equal(o.hint.visible, true);
    env.sendStageEvent(env.motionEvent(100, 100));
    assert.equal(o.highlight.visible, false);
    click(env, 100, 100);
    assert.deepEqual(excluded(env), [[{ enabled: true, wmclass: 'Firefox' }]]);
    assert.equal(env.errors.length, 1);
    assertPickOver(env);
});

test('a mouse move whose coordinates cannot be read is logged and the pick goes on', () => {
    const env = install();
    const s = load();
    addWindow(env, { wmClass: 'Firefox', frame: frame(0, 0, 800, 600) });
    s.callbacks.pickWindow();
    const broken = { type: () => 3, get_coords: () => { throw new Error('coords boom'); } }; // Clutter.EventType.MOTION
    assert.equal(env.sendStageEvent(broken), true);
    assert.equal(env.modalStack.length, 1);
    assert.equal(env.errors.length, 1);
    assert.match(env.errors[0], /coords boom/);
    click(env, 100, 100);
    assert.deepEqual(excluded(env), [[{ enabled: true, wmclass: 'Firefox' }]]);
    assertPickOver(env);
});

test('a hint wider than the primary monitor starts at its left edge; a narrower one stays centred', () => {
    const width = HINT_EXCLUDE.length * 7; // the mock label's natural width
    const run = monitorWidth => {
        const monitors = [{ x: 300, y: 20, width: monitorWidth, height: 768 }];
        const env = install({ monitors: monitors });
        const s = load();
        s.callbacks.pickWindow();
        const o = overlay(env);
        assert.equal(env.errors, undefined);
        return [o.hint.x, o.hint.y];
    };
    assert.deepEqual(run(width - 100), [300, 80]);
    assert.deepEqual(run(width + 100), [300 + 50, 80]);
});
