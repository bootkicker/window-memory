const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'files', 'window-memory@bootkicker');
const schema = JSON.parse(fs.readFileSync(path.join(dir, 'settings-schema.json'), 'utf8'));
const EXPECTED = [
    'layout', 'startup-list', 'version-info', 'version-info-login', 'enabled', 'remember-size', 'remember-position', 'remember-monitor', 'remember-workspace',
    'remember-maximized', 'remember-minimized', 'match-by-title', 'include-dialogs', 'excluded-apps', 'pick-window',
    'max-entries', 'startup-pick', 'forget-focused', 'forget-all', 'backup',
];
const NO_DESCRIPTION = ['layout', 'startup-list'];
// The rows of the "General" tab, in this order: the never-remember list, then the "Pick a window" button below it.
// max-entries is not a row of its own: pick_button.py puts its spin button at the right end of the list's toolbar.
const GENERAL_KEYS = [
    'enabled', 'remember-size', 'remember-position', 'remember-monitor', 'remember-workspace', 'remember-maximized',
    'remember-minimized', 'match-by-title', 'include-dialogs', 'excluded-apps', 'pick-window',
    'forget-focused', 'forget-all', 'backup', 'version-info',
];
// Keys that store a value but are in no section of the layout: the hidden startup-pick (no widget at all) and
// max-entries (shown by pick_button.py in the toolbar of the never-remember list).
const NOT_IN_A_SECTION = ['startup-pick', 'max-entries'];
// The rows of the "General" tab in the order they are shown: the keys of the sections of its page in the layout
// (xlet-settings.py, build_with_layout, adds each section's keys in turn; layoutOf is below). The order of the keys
// in the file itself no longer decides where a row is shown.
function generalRows() {
    return layoutOf().keysOf('general');
}
const TYPES = ['layout', 'switch', 'entry', 'keybinding', 'spinbutton', 'generic', 'list', 'button', 'label', 'combobox', 'custom'];

test('schema declares exactly the documented keys, each with a description and known type', () => {
    assert.deepEqual(Object.keys(schema).sort(), [...EXPECTED].sort());
    for (const key of EXPECTED) {
        // startup-pick is a hidden result key: the settings window builds no widget for a generic, so it has no text.
        // The layout holds titles instead, and startup-list is a widget with an explanation of its own (startup_list.py).
        if (schema[key].type !== 'generic' && !NO_DESCRIPTION.includes(key)) assert.ok(schema[key].description, key + ' description');
        assert.ok(TYPES.includes(schema[key].type), key + ' type');
    }
});

test('startup-pick is the only hidden key: a generic with an empty default, no description and no tooltip, read by no widget', () => {
    assert.deepEqual(schema['startup-pick'], { type: 'generic', default: '' });
    assert.deepEqual(Object.keys(schema).filter(k => schema[k].type === 'generic'), ['startup-pick']);
});

test('remember-minimized is a switch, default true, directly after remember-maximized', () => {
    const item = schema['remember-minimized'];
    assert.ok(item, 'remember-minimized is declared');
    assert.equal(item.type, 'switch');
    assert.equal(item.default, true);
    assert.equal(item.description, 'Remember minimized state');
    assert.equal(item.tooltip, 'A window that was minimized when saved reopens minimized.');
    // Directly below it in the General tab.
    const rows = generalRows();
    assert.equal(rows.indexOf('remember-maximized') + 1, rows.indexOf('remember-minimized'));
});

test('combobox default is one of its options; spinbutton default is in range; list has columns', () => {
    // combobox options are {"<label>": <value>} (ui/settings.js:819-828).
    const combo = schema['match-by-title'];
    assert.ok(Object.values(combo.options).includes(combo.default));
    // Cinnamon keeps a stored spinbutton value only if min < value < max (ui/settings.js:815-817).
    const spin = schema['max-entries'];
    assert.ok(spin.default > spin.min && spin.default < spin.max);
    // list requires columns (ui/settings.js:180-186); rows are keyed by column id.
    const cols = schema['excluded-apps'].columns;
    assert.deepEqual(cols.map(c => c.id), ['enabled', 'wmclass']);
});

test('the never-remember list has a centred Enabled checkbox column (default true), then the WM class column with its old title', () => {
    // The stock list (bin/TreeListWidgets.py, class List) draws a boolean column as a Gtk.CellRendererToggle, gives a
    // row saved without the column the column's "default" (on_setting_changed), and with "align" sets the alignment of
    // both the cell renderer and the header (renderer.set_alignment(align, 0.5), column.set_alignment(align)).
    const [enabled, wmclass] = schema['excluded-apps'].columns;
    assert.deepEqual(enabled, { id: 'enabled', title: 'Enabled', type: 'boolean', default: true, align: 0.5 });
    assert.deepEqual(wmclass, { id: 'wmclass', title: 'Never remember these applications (WM class)', type: 'string' });
    assert.equal(schema['excluded-apps'].type, 'list');
    assert.deepEqual(schema['excluded-apps'].default, []);
});

test('max-entries stays in the schema unchanged (the extension reads it), but is no row of the layout', () => {
    assert.deepEqual(schema['max-entries'], {
        type: 'spinbutton', default: 500, min: 10, max: 5000, step: 10, units: 'windows',
        description: 'Maximum remembered windows', tooltip: 'The least recently seen windows are dropped first.',
    });
    const { layout } = layoutOf();
    const listed = layout.pages.flatMap(page => layout[page].sections).flatMap(name => layout[name].keys);
    assert.ok(!listed.includes('max-entries'));
});

test('the button callback names a function enable() returns; the keybinding has no callback', () => {
    assert.equal(schema['forget-all'].callback, 'forgetAll');
    assert.equal(schema['pick-window'].callback, 'pickWindow');
    assert.equal(schema['forget-focused'].callback, undefined);
});

test('the pick-window row sits directly below the excluded-apps list in the General tab', () => {
    const rows = generalRows();
    assert.equal(rows.indexOf('excluded-apps') + 1, rows.indexOf('pick-window'));
    // A custom widget: cinnamon-settings builds it from "file" and "widget" (xlet-settings.py:474-491).
    assert.equal(schema['pick-window'].type, 'custom');
    assert.equal(schema['pick-window'].description, 'Pick a window to never remember (Click it, Esc or right-click to cancel)');
    assert.equal(schema['pick-window'].tooltip, 'Click here, then click the window you want to add to the never-remember list. Escape or a right-click cancels.');
});

test('the pick-window custom widget: the file named by "file" exists and defines the class named by "widget"', () => {
    const item = schema['pick-window'];
    assert.equal(typeof item.file, 'string');
    assert.equal(typeof item.widget, 'string');
    assert.equal(path.basename(item.file), item.file, 'file is a plain name in the extension folder');
    const file = path.join(dir, item.file);
    assert.ok(fs.existsSync(file), item.file + ' exists in files/window-memory@bootkicker');
    const src = fs.readFileSync(file, 'utf8');
    // cinnamon-settings only accepts a SettingsWidget (xlet-settings.py:460-461).
    assert.match(src, new RegExp('^class ' + item.widget + '\\(SettingsWidget\\):', 'm'));
    assert.equal(item.widget, 'PickWindowButton');
    assert.equal(item.file, 'pick_button.py');
});

test('forget-all is a custom widget (forget_button.py, ForgetAllButton) that keeps its description and callback, has no tooltip, and stays directly after the keybinding, above the version row', () => {
    const item = schema['forget-all'];
    // cinnamon-settings builds a custom item from "file" and "widget" (xlet-settings.py:474-491),
    // which is how it gets the warning icon and the border.
    assert.equal(item.type, 'custom');
    assert.equal(item.file, 'forget_button.py');
    assert.equal(item.widget, 'ForgetAllButton');
    assert.equal(item.description, 'Forget all remembered windows (Cannot be undone, Esc to cancel)');
    assert.equal(item.callback, 'forgetAll');
    assert.equal(item.tooltip, undefined);
    assert.equal(path.basename(item.file), item.file, 'file is a plain name in the extension folder');
    const file = path.join(dir, item.file);
    assert.ok(fs.existsSync(file), item.file + ' exists in files/window-memory@bootkicker');
    const src = fs.readFileSync(file, 'utf8');
    // cinnamon-settings only accepts a SettingsWidget (xlet-settings.py:460-461).
    assert.match(src, new RegExp('^class ' + item.widget + '\\(SettingsWidget\\):', 'm'));
    // The row keeps its place in the General tab.
    const rows = generalRows();
    assert.equal(rows.indexOf('forget-focused') + 1, rows.indexOf('forget-all'));
    assert.ok(rows.indexOf('forget-all') < rows.indexOf('version-info'));
});

test('backup is a custom widget (backup_buttons.py, BackupButtons) with two buttons, each with a label and a tooltip, between forget-all and version-info', () => {
    const item = schema.backup;
    assert.equal(item.type, 'custom');
    assert.equal(item.file, 'backup_buttons.py');
    assert.equal(item.widget, 'BackupButtons');
    assert.equal(item.description, 'Back up or restore settings and remembered windows');
    // Not a stored setting and not a schema button: the widget calls importState itself.
    assert.equal(item.default, undefined);
    assert.equal(item.callback, undefined);
    assert.deepEqual(item.buttons, [
        { label: 'Export backup…', tooltip: 'Save every setting, the never-remember list and the remembered windows to a file.' },
        { label: 'Import backup…', tooltip: 'Replace every setting and remembered window with the ones in a backup file. Asks first.' },
    ]);
    assert.equal(path.basename(item.file), item.file, 'file is a plain name in the extension folder');
    const file = path.join(dir, item.file);
    assert.ok(fs.existsSync(file), item.file + ' exists in files/window-memory@bootkicker');
    // cinnamon-settings only accepts a SettingsWidget (xlet-settings.py:460-461).
    assert.match(fs.readFileSync(file, 'utf8'), new RegExp('^class ' + item.widget + '\\(SettingsWidget\\):', 'm'));
    // Its place in the General tab.
    const rows = generalRows();
    assert.equal(rows.indexOf('forget-all') + 1, rows.indexOf('backup'));
    assert.equal(rows.indexOf('backup') + 1, rows.indexOf('version-info'));
});

test('version-info is the last row of the General tab and a custom widget with file and widget set', () => {
    // The last row of the General tab, below "Forget all remembered windows"; "Enable Window Memory" is the first.
    // cinnamon-settings builds a custom item from "file" and "widget" (xlet-settings.py:474-491).
    const rows = generalRows();
    assert.equal(rows[rows.length - 1], 'version-info');
    assert.equal(rows[0], 'enabled');
    // The layout is the first key of the file, before the keys of the rows.
    assert.equal(Object.keys(schema)[0], 'layout');
    const item = schema['version-info'];
    assert.equal(item.type, 'custom');
    assert.equal(item.file, 'version_info.py');
    assert.equal(item.widget, 'VersionInfo');
    assert.equal(item.description, 'Version');
    // Not a stored setting: no default, no callback (the extension never reads or writes it).
    assert.equal(item.default, undefined);
    assert.equal(item.callback, undefined);
});

test('version-info custom widget: the file exists, defines the class named by "widget" as a SettingsWidget, and stays sensitive', () => {
    const item = schema['version-info'];
    assert.equal(path.basename(item.file), item.file, 'file is a plain name in the extension folder');
    const file = path.join(dir, item.file);
    assert.ok(fs.existsSync(file), item.file + ' exists in files/window-memory@bootkicker');
    const src = fs.readFileSync(file, 'utf8');
    // cinnamon-settings only accepts a SettingsWidget (xlet-settings.py:460-461).
    assert.match(src, new RegExp('^class ' + item.widget + '\\(SettingsWidget\\):', 'm'));
    // pick_button.py skips a row with this attribute when it greys out the page.
    assert.match(src, /^    always_sensitive = True$/m);
});

test('no item uses "dependency": cinnamon-settings would hide that row, not grey it out', () => {
    // xlet-settings.py:424-426 wraps an item with "dependency" in a JSONSettingsRevealer, a
    // Gtk.Revealer that calls set_reveal_child (bin/JsonSettingsWidgets.py:229-270). It never
    // calls set_sensitive. The settings window greys rows out while "enabled" is off instead.
    for (const key of EXPECTED) assert.equal(schema[key].dependency, undefined, key + ' has a dependency');
    // Nor a page or a section of the layout (xlet-settings.py:420-423 would reveal the section instead).
    for (const [name, def] of Object.entries(schema.layout)) {
        if (name !== 'type' && name !== 'pages') assert.equal(def.dependency, undefined, 'layout ' + name + ' has a dependency');
    }
});

test('pick_button.py binds the "enabled" switch to its own row and, once shown, to every other row except the switch and rows marked always_sensitive (the version row)', () => {
    // The page checks that prove it run in tests/helpers/pick_button_harness.py (section 9),
    // which needs a display and Cinnamon; this one reads the source and runs anywhere.
    assert.equal(schema.enabled.type, 'switch');
    const src = fs.readFileSync(path.join(dir, schema['pick-window'].file), 'utf8');
    assert.match(src, /^ENABLED_KEY = 'enabled'$/m);
    assert.match(src, /self\.settings\.bind\(ENABLED_KEY, self, 'sensitive', Gio\.SettingsBindFlags\.GET\)/);
    assert.match(src, /self\.connect\('map', self\._on_map\)/);
    assert.match(src, /self\.settings\.bind\(ENABLED_KEY, row, 'sensitive', Gio\.SettingsBindFlags\.GET\)/);
    assert.match(src, /if row is self or getattr\(row, 'key', None\) == ENABLED_KEY or getattr\(row, 'always_sensitive', False\):/);
});

test('the extension writes only keys declared in the schema', () => {
    const src = fs.readFileSync(path.join(dir, 'extension.js'), 'utf8');
    const written = [...src.matchAll(/setValue\('([^']+)'/g)].map(m => m[1]);
    assert.ok(written.length > 0);
    for (const key of written) assert.ok(schema[key], 'undeclared key ' + key);
});

test('the extension reads only keys declared in the schema', () => {
    const src = fs.readFileSync(path.join(dir, 'extension.js'), 'utf8');
    const used = [...src.matchAll(/getValue\('([^']+)'\)/g)].map(m => m[1]);
    assert.ok(used.length > 0);
    for (const key of used) assert.ok(schema[key], 'undeclared key ' + key);
});

test('the match-by-title tooltip explains each option in plain words', () => {
    const tip = schema['match-by-title'].tooltip;
    assert.match(tip, /^Chooses which saved place a window gets when an application has several remembered windows\./);
    assert.match(tip, /Application only: a window takes the newest saved place of its application that no other open window is using\./);
    assert.match(tip, /Application and window title: Window Memory first looks for a saved place whose window had the same title \(capital letters do not matter\)/);
    assert.match(tip, /If no title matches, it behaves like "Application only"\./);
    // The option names are the ones of the combobox, and the text uses no jargon.
    for (const name of Object.keys(schema['match-by-title'].options)) assert.ok(tip.includes(name + ':'), name + ' is explained');
    assert.doesNotMatch(tip, /unclaimed/);
    assert.doesNotMatch(tip, /first remembered/);
});

test('the match-by-title tooltip says that a saved place of a window that was not minimized is preferred when minimized state is remembered, and that a matching title still comes first', () => {
    const tip = schema['match-by-title'].tooltip;
    assert.match(tip, /If "Remember minimized state" is on, a saved place where the window was not minimized is preferred, so that when an application had one minimized and one normal window, at least one of them opens visible\. A matching title still comes first\.$/);
});

test('the excluded-apps tooltip keeps its xprop help, says what an unchecked entry does, and ends by pointing to the Pick a window button', () => {
    const tip = schema['excluded-apps'].tooltip;
    assert.match(tip, /^Windows of these applications are never saved or restored\. Enter the WM_CLASS: run xprop WM_CLASS in a terminal, then click the window\. Matching ignores case and accepts part of the name\. An unchecked entry stays in the list but is ignored: windows of that application are remembered again\./);
    assert.ok(tip.endsWith(' You can also use the "Pick a window" button instead to add entries automatically.'), tip);
});

// ---- the two tabs of the settings window ----------------------------------------------------------------------
// cinnamon-settings builds the window from the layout when the first key is of type "layout"
// (xlet-settings.py:326-331, build_with_layout): "pages" names the tabs, each page lists "sections", each section lists
// "keys" and has a "title". It calls translate(uuid, title) and page.add_section(title) for every section, and
// SettingsSection draws the title as a heading (and none for an empty title: xapp/SettingsWidgets.py, `if title or subtitle`).
function layoutOf() {
    const layout = schema.layout;
    const sectionsOf = (pageName) => layout[pageName].sections;
    return { layout, sectionsOf, keysOf: (pageName) => sectionsOf(pageName).flatMap(section => layout[section].keys) };
}

test('the first key is the layout, with exactly the two tabs "General" and "Startup apps"', () => {
    assert.equal(Object.keys(schema)[0], 'layout');
    const { layout } = layoutOf();
    assert.equal(layout.type, 'layout');
    assert.deepEqual(layout.pages, ['general', 'login']);
    assert.equal(layout.general.type, 'page');
    assert.equal(layout.general.title, 'General');
    assert.equal(layout.login.type, 'page');
    assert.equal(layout.login.title, 'Startup apps');
    // The layout has a page and a section only for what it names: nothing unused, nothing missing.
    const named = new Set(['type', 'pages', ...layout.pages, ...layout.pages.flatMap(page => layout[page].sections)]);
    assert.deepEqual(Object.keys(layout).filter(k => !named.has(k)), []);
    for (const name of layout.pages.flatMap(page => layout[page].sections)) {
        assert.equal(layout[name].type, 'section', name);
        assert.equal(typeof layout[name].title, 'string', name + ' has a title (xlet-settings.py reads it for every section)');
        assert.ok(Array.isArray(layout[name].keys), name + ' has keys');
    }
});

test('both sections carry the heading "Settings for window-memory@bootkicker", the default heading of a page without a layout (an own text of the extension: the uuid is part of the msgid)', () => {
    const { layout } = layoutOf();
    const names = layout.pages.flatMap(page => layout[page].sections);
    assert.equal(names.length, 2);
    // The engine draws the title of a section as the heading of the tab (xapp SettingsSection) after translate(uuid, title).
    for (const name of names) assert.equal(layout[name].title, 'Settings for window-memory@bootkicker', name);
});

test('every key except the hidden startup-pick, max-entries (in the list toolbar) and the layout is in exactly one section, and each section names declared keys', () => {
    const { layout } = layoutOf();
    const listed = layout.pages.flatMap(page => layout[page].sections).flatMap(name => layout[name].keys);
    for (const key of listed) assert.ok(schema[key] && key !== 'layout', 'a section names the undeclared key ' + key);
    assert.equal(new Set(listed).size, listed.length, 'a key is in two places');
    const expected = Object.keys(schema).filter(k => k !== 'layout' && !NOT_IN_A_SECTION.includes(k));
    assert.deepEqual([...listed].sort(), expected.sort());
    assert.ok(!listed.includes('startup-pick'), 'the hidden key is in no section');
});

test('the General tab shows its rows in the documented order, the same order as the keys in the file', () => {
    const { keysOf } = layoutOf();
    assert.deepEqual(keysOf('general'), GENERAL_KEYS);
    // Same relative order as the keys of the schema itself, so that the file reads in the order of the page.
    assert.deepEqual(Object.keys(schema).filter(k => GENERAL_KEYS.includes(k)), GENERAL_KEYS);
    assert.equal(schema['match-by-title'].description, 'Match windows by');
    assert.equal(schema['remember-monitor'].tooltip, 'When off, the position is kept relative to the monitor the window opens on.');
});

test('the Startup apps tab holds one section: the startup-list widget, then the Version footer of its own key', () => {
    const { layout, sectionsOf, keysOf } = layoutOf();
    assert.equal(sectionsOf('login').length, 1);
    assert.deepEqual(keysOf('login'), ['startup-list', 'version-info-login']);
    // The widget carries its own explanation, so the section has no "label" key and the widget no description of its own.
    assert.ok(!layout[sectionsOf('login')[0]].keys.some(k => schema[k].type === 'label'));
    assert.equal(schema['startup-list'].description, undefined);
});

test('version-info-login is the second instance of the Version row: the same custom widget, file and description as version-info, stores nothing', () => {
    // A key of its own, so that the engine builds each key once (build_with_layout makes one widget per key listed).
    assert.deepEqual(schema['version-info-login'], schema['version-info']);
    assert.equal(schema['version-info-login'].type, 'custom');
    assert.equal(schema['version-info-login'].default, undefined);
    // It follows version-info in the file, so that the keys of the General tab keep their order in the file.
    const keys = Object.keys(schema);
    assert.equal(keys.indexOf('version-info-login'), keys.indexOf('version-info') + 1);
    // Both tabs end with the Version row.
    const { keysOf } = layoutOf();
    assert.equal(keysOf('general').at(-1), 'version-info');
    assert.equal(keysOf('login').at(-1), 'version-info-login');
});

test('startup-list is a custom widget: the file named by "file" exists and defines the class named by "widget"', () => {
    const item = schema['startup-list'];
    assert.equal(item.type, 'custom');
    assert.equal(item.file, 'startup_list.py');
    assert.equal(item.widget, 'StartupList');
    assert.equal(path.basename(item.file), item.file, 'file is a plain name in the extension folder');
    const file = path.join(dir, item.file);
    assert.ok(fs.existsSync(file), item.file + ' exists in files/window-memory@bootkicker');
    // The class is made on first access by a module-level __getattr__ (it needs GTK), so it is named in the source
    // as the class of the body and returned for the widget name; the Python harness loads it for real.
    const src = fs.readFileSync(file, 'utf8');
    assert.match(src, new RegExp('class ' + item.widget + '\\('));
    // A custom item stores nothing: no default, no callback.
    assert.equal(item.default, undefined);
});

test('startup-pick is the hidden generic key: default "", and no section shows it', () => {
    assert.equal(schema['startup-pick'].type, 'generic');
    assert.equal(schema['startup-pick'].default, '');
    assert.ok(!Object.values(schema.layout).some(def => Array.isArray(def && def.keys) && def.keys.includes('startup-pick')));
});
