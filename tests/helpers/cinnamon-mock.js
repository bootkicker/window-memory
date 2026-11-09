// SPDX-License-Identifier: GPL-3.0-or-later
// Test-only fake of the Cinnamon/GJS globals that extension.js touches.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const schema = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'files', 'window-memory@bootkicker', 'settings-schema.json'), 'utf8'));
const DEFAULTS = Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, v.default]));

const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';

// One exit hook removes every temp config dir that install() created.
const tempDirs = [];
process.on('exit', () => {
    for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

function emitter(extra) {
    const handlers = {};
    return Object.assign({
        handlers: handlers,
        connect(sig, fn) { (handlers[sig] = handlers[sig] || []).push(fn); return fn; },
        disconnect(fn) { for (const k of Object.keys(handlers)) handlers[k] = handlers[k].filter(f => f !== fn); },
        emit(sig, ...args) { for (const f of (handlers[sig] || []).slice()) f(...args); },
    }, extra);
}

function makeWindow(env, p) {
    const actor = emitter({});
    const win = emitter(Object.assign({
        wmClass: 'Firefox', instance: 'Navigator', role: '', title: 'Page', type: 0,
        frame: { x: 100, y: 100, width: 800, height: 600 }, monitor: 0, workspace: 0, maximized: 0, showing: true,
        clientType: 1, // Meta.WindowClientType: 0 is a native Wayland client, 1 is X11 (muffin meta/window.h:85-93)
        transientFor: null, // the window this one is a dialog for, or null
        minimized: false, // Meta.Window.minimized is a readable boolean property (muffin core/window.c:534-537)
        // The application Cinnamon's window tracker gives the window (Cinnamon.WindowTracker below): {name, windowBacked},
        // or null for none. windowBacked: Cinnamon found no .desktop file for the window (ui/lookingGlass.js:209-210).
        // desktopFile: the path get_app_info().get_filename() gives; without it get_app_info() is null, as for a window-backed app.
        app: null,
        // Meta.Window.get_pid(): 0 when the client gave no pid. pidThrows: get_pid fails.
        pid: 0,
        moves: [], ops: [],
    }, p || {}));
    actor.meta_window = win;
    Object.assign(win, {
        is_override_redirect: () => false,
        is_on_all_workspaces: () => false,
        // Meta.Window.showing_on_its_workspace (ui/windowManager.js:1141): false for a minimized window; set `showing` to false.
        showing_on_its_workspace: () => win.showing,
        get_wm_class: () => win.wmClass,
        get_wm_class_instance: () => win.instance,
        get_role: () => win.role,
        get_title: () => win.title,
        get_window_type: () => win.type,
        get_frame_rect: () => ({ x: win.frame.x, y: win.frame.y, width: win.frame.width, height: win.frame.height }),
        get_monitor: () => win.monitor,
        get_workspace: () => ({ index: () => win.workspace, get_work_area_for_monitor: i => env.workAreaFor(i) }),
        get_maximized: () => win.maximized,
        is_fullscreen: () => false,
        get_compositor_private: () => actor,
        get_client_type: () => win.clientType,
        get_pid: () => { if (win.pidThrows) throw new Error('get_pid failed'); return win.pid; },
        get_transient_for: () => win.transientFor,
        // Meta.Window.move_frame (muffin meta/window.h): moves the frame without changing its size.
        move_frame(user, x, y) {
            win.frame = { x: x, y: y, width: win.frame.width, height: win.frame.height };
            win.frameMoves = (win.frameMoves || []).concat([[x, y]]);
            const i = env.monitorAt(x + win.frame.width / 2, y + win.frame.height / 2);
            if (i >= 0) win.monitor = i;
        },
        // Like Muffin, the monitor follows the frame: the one that holds the new frame's center.
        move_resize_frame(user, x, y, w, h) {
            win.frame = { x: x, y: y, width: w, height: h };
            win.moves.push([x, y, w, h]);
            const i = env.monitorAt(x + w / 2, y + h / 2);
            if (i >= 0) win.monitor = i;
        },
        change_workspace(ws) { win.workspace = ws.index(); },
        maximize(flags) { win.maximized = flags; win.ops.push('maximize'); },
        // Meta.Window.move_to_monitor (ui/workspace.js:628)
        move_to_monitor(i) { win.monitor = i; win.ops.push('move_to_monitor:' + i); },
        // Meta.Window.minimize and unminimize (ui/windowMenu.js:196; muffin core/window.c:2828-2877). Each sets the flag and
        // sends notify::minimized at once; here it does nothing when the window is already in that state. Muffin hides or
        // shows the window later, in its next CALC_SHOWING pass: here a minimized window stops showing at once, and
        // unminimizing it shows it again and sends 'shown' (core/window.c:2730), the signal of a hidden window shown again.
        minimize() {
            if (win.minimized) return;
            win.minimized = true;
            win.showing = false;
            win.ops.push('minimize');
            win.emit('notify::minimized', win, null);
        },
        unminimize() {
            if (!win.minimized) return;
            win.minimized = false;
            win.showing = true;
            win.ops.push('unminimize');
            win.emit('notify::minimized', win, null);
            win.emit('shown', win);
        },
    });
    return win;
}

function install(opts) {
    opts = opts || {};
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-'));
    tempDirs.push(configDir);
    const timers = new Map();
    const timerMs = new Map(); // timer id -> its delay in ms, for the timers still pending
    let nextId = 1;
    // removedSources: every id passed to GLib.source_remove, in order (removing a timer that already ran is a GLib warning).
    // homeDir: what GLib.get_home_dir() gives; nothing is written there.
    // userDataDir: what GLib.get_user_data_dir() gives, <homeDir>/.local/share as with no XDG_DATA_HOME; a test may change it.
    const env = {
        configDir: configDir, homeDir: path.join(configDir, 'home'), timers: timers, timerMs: timerMs, removedSources: [], windows: [],
        moves: [], procFiles: {},
    };
    env.userDataDir = path.join(env.homeDir, '.local', 'share');

    // The boot id of the running kernel (/proc/sys/kernel/random/boot_id, one line): opts.bootId, 'test-boot' by default; null
    // for a file that is not there. Only that exact path is faked; the tests never read the real one.
    const bootId = opts.bootId === undefined ? 'test-boot' : opts.bootId;
    const Gio = {
        FileCopyFlags: { OVERWRITE: 1 },
        FileCreateFlags: { NONE: 0 },
        File: {
            new_for_path: p => (p === BOOT_ID_PATH ? {
                path: p,
                query_exists: () => bootId !== null,
                load_contents: () => [true, Buffer.from(bootId + '\n')],
            } : {
                path: p,
                query_exists: () => fs.existsSync(p),
                load_contents: () => [true, fs.readFileSync(p)],
                make_directory_with_parents: () => fs.mkdirSync(p, { recursive: true }),
                replace: () => ({ path: p }),
                move: dest => fs.renameSync(p, dest.path),
                // Gio.File.delete (ui/appletManager.js:359). Like it, this throws for a file that is not there,
                // but not the same error: the real call raises a GLib.Error (Gio.IOErrorEnum.NOT_FOUND), this
                // a Node error (ENOENT).
                delete: () => fs.unlinkSync(p),
            }),
        },
        BufferedOutputStream: {
            new_sized: raw => ({ text: '', close() { fs.writeFileSync(raw.path, this.text); } }),
        },
    };
    // Cinnamon.WindowTracker.get_default() (ui/main.js:325) returns the tracker; its get_window_app(win) returns the
    // application of the window, with get_name() and is_window_backed() (ui/lookingGlass.js:209-210,
    // ui/appSwitcher/classicSwitcher.js:437), or null. Here that is the window's `app` (see makeWindow).
    const tracker = {
        get_window_app: w => {
            if (w && w.trackerThrows) throw new Error('get_window_app failed');
            if (!w || !w.app) return null;
            return {
                get_name: () => w.app.name,
                get_id: () => w.app.id || null,
                is_window_backed: () => !!w.app.windowBacked,
                // Cinnamon.App.get_app_info() gives a Gio.DesktopAppInfo (get_filename() is its path), or null with no desktop file.
                get_app_info: () => {
                    if (w.app.infoThrows) throw new Error('get_app_info failed');
                    return w.app.desktopFile ? { get_filename: () => w.app.desktopFile } : null;
                },
            };
        },
    };
    // Cinnamon.Cursor.CROSSHAIR is 13 and StageInputMode.NORMAL / FULLSCREEN are 1 / 3 in the installed typelib.
    const Cinnamon = {
        write_string_to_stream: (out, s) => { out.text += s; },
        Cursor: { CROSSHAIR: 13 },
        StageInputMode: { NORMAL: 1, FULLSCREEN: 3 },
        WindowTracker: { get_default: () => tracker },
    };
    // Idle callbacks wait in env.idles until a test calls env.runIdles(), as they wait for the main loop.
    // GLib.source_remove drops a pending idle as it drops a pending timer (the ids come from one counter).
    const idles = new Map();
    const GLib = {
        PRIORITY_DEFAULT: 0,
        SOURCE_REMOVE: false,
        get_home_dir: () => env.homeDir,
        get_user_data_dir: () => env.userDataDir,
        get_user_config_dir: () => configDir,
        // GLib.getenv: opts.env gives the environment of the session ({XDG_SESSION_ID: 'c2'}); a name not in it is null.
        getenv: name => (opts.env || {})[name] ?? null,
        timeout_add: (prio, ms, fn) => { const id = nextId++; timers.set(id, fn); timerMs.set(id, ms); return id; },
        source_remove: id => {
            env.removedSources.push(id);
            timerMs.delete(id);
            return timers.delete(id) || idles.delete(id);
        },
        idle_add: (prio, fn) => { const id = nextId++; idles.set(id, fn); return id; },
        // GLib.file_get_contents(path) -> [ok, Uint8Array] (cjs 6.0.0, checked): it throws for a file that cannot be read. Only
        // /proc/<pid>/cmdline is faked, from env.procFiles {path: Buffer or string}; any other path is not there.
        file_get_contents: p => {
            if (!Object.prototype.hasOwnProperty.call(env.procFiles, p)) throw new Error('Failed to open file ' + p + ': No such file or directory');
            return [true, new Uint8Array(Buffer.from(env.procFiles[p]))];
        },
    };
    const monitors = opts.monitors || [{ x: 0, y: 0, width: 1920, height: 1080 }];
    // Each monitor has its own work area: opts.workAreas[index] when given (a panel takes some room), else the monitor's own rect.
    env.workAreas = opts.workAreas || {};
    env.workAreaFor = i => {
        if (env.workAreas[i]) return env.workAreas[i];
        const m = Main.layoutManager.monitors[i];
        return m ? { x: m.x, y: m.y, width: m.width, height: m.height } : null;
    };
    // Registered hotkeys by name -> {accel, callback}, so tests can inspect and press them.
    env.hotkeys = {};
    // Modal grabs: env.modalStack holds the actors pushed and not yet popped (like Main's modalActorFocusStack).
    // Set env.grabFails to make pushModal refuse, as it does when begin_modal fails (ui/main.js:1217-1220).
    env.modalStack = [];
    env.modalPushes = 0;
    env.modalPops = 0;
    env.grabFails = false;
    env.cursor = null;
    // The global grab behind the modal stack: pushModal puts the stage in FULLSCREEN input mode, and the last popModal
    // calls end_modal and puts it back to NORMAL (ui/main.js:1224, 1265-1311). endModalCalls holds the timestamps.
    env.stageInputMode = Cinnamon.StageInputMode.NORMAL;
    env.endModalCalls = [];
    // Every Main.notify call, as [title, body].
    env.notifications = [];
    const uiGroup = {
        children: [],
        add_actor(a) { this.children.push(a); },
        set_child_above_sibling(a, sibling) { this.children = this.children.filter(c => c !== a).concat([a]); },
    };
    const Main = {
        // primaryMonitor is monitors[primaryIndex] (ui/layout.js:204).
        layoutManager: emitter({ monitors: monitors, primaryIndex: 0, primaryMonitor: monitors[0] }),
        keybindingManager: {
            addHotKey(name, accel, callback) { env.hotkeys[name] = { accel: accel, callback: callback }; return true; },
            removeHotKey(name) { delete env.hotkeys[name]; },
        },
        uiGroup: uiGroup,
        // Main.notify(msg, details) (ui/main.js:751-757) shows a transient notification with the title msg and the body
        // details. Here it records the two in env.notifications.
        notify(msg, details) { env.notifications.push([msg, details]); },
        // Main.modalCount (ui/main.js:156) is the number of modals pushed and not yet popped.
        get modalCount() { return env.modalStack.length; },
        pushModal(actor) {
            if (env.grabFails) return false;
            env.modalStack.push(actor);
            env.modalPushes++;
            global.set_stage_input_mode(Cinnamon.StageInputMode.FULLSCREEN);
            return true;
        },
        // popModal of an actor that is not on the stack ends the grab and throws, as in ui/main.js:1270-1276.
        popModal(actor) {
            const i = env.modalStack.indexOf(actor);
            if (i < 0) {
                global.end_modal(global.get_current_time());
                global.set_stage_input_mode(Cinnamon.StageInputMode.NORMAL);
                throw new Error('incorrect pop');
            }
            env.modalStack.splice(i, 1);
            env.modalPops++;
            if (env.modalStack.length === 0) {
                global.end_modal(global.get_current_time());
                global.set_stage_input_mode(Cinnamon.StageInputMode.NORMAL);
            }
        },
    };
    env.monitorAt = (x, y) => Main.layoutManager.monitors.findIndex(
        m => x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height);
    // Unplug or plug a monitor: replaces the layout and emits 'monitors-changed' as Cinnamon's layout manager does.
    env.setMonitors = list => {
        Main.layoutManager.monitors = list;
        Main.layoutManager.primaryMonitor = list[Main.layoutManager.primaryIndex] || null;
        Main.layoutManager.emit('monitors-changed', Main.layoutManager);
    };
    const settingsValues = Object.assign({}, DEFAULTS, opts.settings || {});
    env.settingsFinalized = false;
    env.settingsEmitter = emitter({});
    // Cinnamon emits 'changed::<key>' with (settings, key, oldValue, newValue) (ui/settings.js:623).
    env.changeSetting = (key, value) => {
        const old = settingsValues[key];
        settingsValues[key] = value;
        env.settingsEmitter.emit('changed::' + key, env.settingsEmitter, key, old, value);
    };
    // Every setValue call, as [key, value]. Cinnamon's setValue (ui/settings.js:509-515) stores and saves the value
    // and emits no 'changed::<key>' for it: the file monitor is disconnected while saving (:844-852).
    env.setValueCalls = [];
    class ExtensionSettings {
        // Cinnamon gives the settings object the extension it belongs to (ui/settings.js:939); env.owner is that object, so a
        // test can reach the instance behind enable().
        constructor(owner) { this.values = settingsValues; env.owner = owner; }
        getValue(k) { return this.values[k]; }
        setValue(k, v) { env.setValueCalls.push([k, v]); this.values[k] = v; }
        connect(sig, fn) { return env.settingsEmitter.connect(sig, fn); }
        finalize() { env.settingsFinalized = true; env.settingsEmitter.handlers = {}; }
    }
    const SignalManager = {
        SignalManager: class {
            constructor() { this._list = []; }
            connect(obj, sig, fn, bind) { this._list.push([obj, obj.connect(sig, (...a) => fn.apply(bind, a))]); }
            disconnectAllSignals() { for (const [o, id] of this._list) o.disconnect(id); this._list = []; }
        },
    };
    // Laters wait in env.laters, id -> {when, fn}, until a test calls env.runLaters(), as they wait for Muffin's next repaint
    // pass. Meta.later_add and later_remove are public (muffin meta/util.h:211-217). LaterType has the values of the installed
    // typelib (RESIZE 0 to IDLE 5, in this order). env.removedLaters: every id passed to Meta.later_remove.
    const laters = new Map();
    env.removedLaters = [];
    const Meta = {
        WindowType: { NORMAL: 0, DIALOG: 1, MODAL_DIALOG: 2, DOCK: 3, DESKTOP: 4, SPLASHSCREEN: 5 },
        MaximizeFlags: { BOTH: 3 },
        // Muffin's version (the typelib's Meta.MAJOR_VERSION, MINOR_VERSION, MICRO_VERSION: 6.0.1 on Cinnamon 6.0.5).
        MAJOR_VERSION: 6,
        MINOR_VERSION: 0,
        MICRO_VERSION: 1,
        WindowClientType: { WAYLAND: 0, X11: 1 },
        // Meta.Window.prototype: the members of a window that extension.js needs to exist (requiredMissing). makeWindow gives each
        // window its own working versions; these only have to be there, as they are in the typelib.
        Window: { prototype: Object.fromEntries(['get_frame_rect', 'move_resize_frame', 'move_frame', 'move_to_monitor', 'maximize',
            'minimize', 'get_monitor', 'get_workspace', 'get_wm_class', 'get_wm_class_instance', 'get_window_type', 'get_maximized',
            'change_workspace'].map(name => [name, () => {}])) },
        is_wayland_compositor: () => !!opts.wayland,
        LaterType: { RESIZE: 0, CALC_SHOWING: 1, CHECK_FULLSCREEN: 2, SYNC_STACK: 3, BEFORE_REDRAW: 4, IDLE: 5 },
        later_add: (when, fn) => { const id = nextId++; laters.set(id, { when: when, fn: fn }); return id; },
        later_remove: id => { env.removedLaters.push(id); laters.delete(id); },
    };

    // Clutter values as the installed typelib reports them (EventType.KEY_PRESS 1, MOTION 3, BUTTON_PRESS 6,
    // BUTTON_RELEASE 7, BUTTON_PRIMARY 1, BUTTON_MIDDLE 2, BUTTON_SECONDARY 3, KEY_Escape 65307, BindCoordinate.ALL 6,
    // EVENT_STOP true, EVENT_PROPAGATE false).
    const Clutter = {
        EventType: { KEY_PRESS: 1, MOTION: 3, BUTTON_PRESS: 6, BUTTON_RELEASE: 7 },
        BUTTON_PRIMARY: 1,
        BUTTON_MIDDLE: 2,
        BUTTON_SECONDARY: 3,
        KEY_Escape: 65307,
        EVENT_STOP: true,
        EVENT_PROPAGATE: false,
        BindCoordinate: { ALL: 6 },
        BindConstraint: class { constructor(props) { Object.assign(this, props); } },
        FixedLayout: class {},
    };
    // St.Widget and St.Label, with the Clutter.Actor members the pick uses. An actor is shown unless built with
    // visible: false. Destroying an actor destroys its children, as Clutter does. env.widgetCalls counts the calls of
    // set_position, set_size, show, hide, set_text and get_preferred_width on every actor, so a test can see that nothing was redrawn.
    // env.actorFails: {method: true} makes that member throw on every actor (a constructor: 'Widget' or 'Label').
    env.widgetCalls = { set_position: 0, set_size: 0, show: 0, hide: 0, set_text: 0, get_preferred_width: 0 };
    env.actorFails = {};
    const failing = name => { if (env.actorFails[name]) throw new Error(name + ' boom'); env.widgetCalls[name]++; };
    class Widget {
        constructor(props) {
            if (env.actorFails[this.constructor.name]) throw new Error(this.constructor.name + ' boom');
            this.visible = true;
            this.x = 0;
            this.y = 0;
            Object.assign(this, props);
            this.constraints = [];
            this.children = [];
            this.parent = null;
            this.destroyed = false;
        }
        add_constraint(c) { this.constraints.push(c); }
        add_child(child) { this.children.push(child); child.parent = this; }
        destroy_all_children() { const list = this.children; this.children = []; list.forEach(c => c.destroy()); }
        set_position(x, y) { failing('set_position'); this.x = x; this.y = y; }
        set_size(w, h) { failing('set_size'); this.width = w; this.height = h; }
        show() { failing('show'); this.visible = true; }
        hide() { failing('hide'); this.visible = false; }
        destroy() {
            this.destroyed = true;
            this.children.forEach(c => c.destroy());
            uiGroup.children = uiGroup.children.filter(c => c !== this);
        }
    }
    // St.Label: its natural width is 7 px per character of its text, for the centring of the pick's hint.
    // get_preferred_width(forHeight) gives [minimum, natural] (ui/panel.js:3305).
    class Label extends Widget {
        constructor(props) {
            super(Object.assign({ text: '' }, props));
        }
        set_text(t) { failing('set_text'); this.text = t; }
        get_preferred_width() { failing('get_preferred_width'); return [0, this.text.length * 7]; }
    }
    env.display = emitter({ focus_window: null });
    env.wm = emitter({});
    env.stage = emitter({ width: 1920, height: 1080 });
    env.uiGroup = uiGroup;
    global.display = env.display;
    global.window_manager = env.wm;
    global.stage = env.stage;
    global.set_cursor = c => { env.cursor = c; };
    global.unset_cursor = () => { env.cursor = null; };
    global.get_current_time = () => 1234567;
    global.end_modal = t => { env.endModalCalls.push(t); };
    global.set_stage_input_mode = m => { env.stageInputMode = m; };
    // env.windowListings counts the calls, so a test can see how often the pick lists the windows.
    env.windowListings = 0;
    global.get_window_actors = () => { env.windowListings++; return env.windows.map(w => w.get_compositor_private()); };
    // global.get_pointer() gives [x, y, mods] (ui/messageTray.js:1041). env.pointer is off every window unless a test sets it.
    env.pointer = [-1, -1];
    global.get_pointer = () => [env.pointer[0], env.pointer[1], 0];
    global.workspace_manager = {
        get_workspace_by_index: i => ({ index: () => i }),
        get_active_workspace: () => ({ index: () => 0, get_work_area_for_monitor: i => env.workAreaFor(i) }),
    };
    global.log = () => {};
    global.logWarning = () => {};
    global.logError = e => { env.errors = (env.errors || []).concat([String(e)]); };
    // imports.gettext, the cjs module (modules/script/gettext.js): bindtextdomain(domain, folder) tells gettext where the
    // .mo files of a domain are, and dgettext(domain, msgid) translates msgid in that domain. Here no translation is
    // installed: dgettext gives msgid back, and bindtextdomain only records its arguments in env.textDomains. A test can
    // give a domain translations in env.translations, {domain: {msgid: translation}}.
    env.textDomains = [];
    env.translations = {};
    const Gettext = {
        bindtextdomain(domain, folder) { env.textDomains.push([domain, folder]); },
        dgettext(domain, msgid) {
            const table = env.translations[domain];
            return table && Object.prototype.hasOwnProperty.call(table, msgid) ? table[msgid] : msgid;
        },
    };
    globalThis.imports = {
        // ui.extension: Cinnamon 6.0 to 6.6 have no getCurrentExtension() there; a test of the 6.8 path adds one.
        ui: { main: Main, settings: { ExtensionSettings: ExtensionSettings }, extension: {} },
        // imports.misc.config.PACKAGE_VERSION is Cinnamon's version (misc/config.js, generated at build time).
        misc: { signalManager: SignalManager, config: { PACKAGE_VERSION: opts.cinnamonVersion || '6.0.5' } },
        gi: { Meta: Meta, GLib: GLib, Gio: Gio, Cinnamon: Cinnamon, Clutter: Clutter, St: { Widget: Widget, Label: Label } },
        byteArray: { toString: b => Buffer.from(b).toString('utf8') },
        gettext: Gettext,
    };
    // Runs every pending timer, and the timers those timers schedule (a capture timer schedules the save timer).
    env.runTimers = () => {
        for (let round = 0; timers.size > 0 && round < 100; round++) {
            for (const [id, fn] of [...timers]) { timers.delete(id); timerMs.delete(id); fn(); }
        }
    };
    env.runIdles = () => {
        for (const [id, fn] of [...idles]) { idles.delete(id); fn(); }
    };
    env.idles = idles;
    // Runs every pending later once, in the order added. A callback that returns true stays queued for the next pass, as
    // in Muffin; one that returns false (the extension's does) is removed. A later removed by an earlier callback is skipped.
    env.runLaters = () => {
        for (const [id, later] of [...laters]) {
            if (!laters.has(id)) continue;
            if (later.fn() !== true) laters.delete(id);
        }
    };
    env.laters = laters;
    // Stage events for a pick: the stage's 'captured-event' handlers run in connection order, and the first one that
    // returns true (Clutter.EVENT_STOP) stops the event. Returns whether the event was stopped.
    env.sendStageEvent = event => {
        for (const f of (env.stage.handlers['captured-event'] || []).slice()) {
            if (f(env.stage, event) === true) return true;
        }
        return false;
    };
    env.keyEvent = symbol => ({ type: () => Clutter.EventType.KEY_PRESS, get_key_symbol: () => symbol });
    // button defaults to the primary (left) button
    env.pressEvent = (x, y, button) => ({
        type: () => Clutter.EventType.BUTTON_PRESS, get_coords: () => [x, y], get_button: () => button || Clutter.BUTTON_PRIMARY,
    });
    env.releaseEvent = (x, y, button) => ({
        type: () => Clutter.EventType.BUTTON_RELEASE, get_coords: () => [x, y], get_button: () => button || Clutter.BUTTON_PRIMARY,
    });
    env.motionEvent = (x, y) => ({ type: () => Clutter.EventType.MOTION, get_coords: () => [x, y] });
    env.makeWindow = p => makeWindow(env, p);
    // Cinnamon's window manager emits 'map' with (cinnamonwm, actor) (ui/windowManager.js:282, 830).
    env.mapWindow = w => env.wm.emit('map', env.wm, w.get_compositor_private());
    env.statePath = path.join(configDir, 'window-memory', 'state.json');
    env.safetyPath = path.join(path.dirname(env.statePath), 'safety.json');
    return env;
}

module.exports = { install, DEFAULTS };
