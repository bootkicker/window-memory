const test = require('node:test');
const assert = require('node:assert/strict');
const { lib } = require('./helpers/load-cinnamon-module.js');
const I = lib('identity');

const normal = { type: 'normal', wmClass: 'Firefox', instance: 'Navigator', role: 'browser', title: 'Mozilla' };
const noDialogs = { includeDialogs: false, excludedApps: [] };

test('windowKey lowercases and joins class and instance; the role is not part of the key', () => {
    assert.equal(I.windowKey(normal), 'firefox|navigator');
});

test('windowKey is null without a WM_CLASS', () => {
    assert.equal(I.windowKey({ wmClass: '', instance: 'x', role: '' }), null);
});

test('normal windows are eligible', () => {
    assert.equal(I.isEligible(normal, noDialogs), true);
});

test('dialogs are eligible only when includeDialogs is on', () => {
    const dialog = Object.assign({}, normal, { type: 'dialog' });
    assert.equal(I.isEligible(dialog, noDialogs), false);
    assert.equal(I.isEligible(dialog, { includeDialogs: true, excludedApps: [] }), true);
});

test('desktop, dock and splash windows are never eligible', () => {
    const other = Object.assign({}, normal, { type: 'other' });
    assert.equal(I.isEligible(other, { includeDialogs: true, excludedApps: [] }), false);
});

test('windows without a WM_CLASS are never eligible', () => {
    assert.equal(I.isEligible(Object.assign({}, normal, { wmClass: '' }), noDialogs), false);
});

test('pop-up windows (role "pop-up") are never eligible, whatever the type or the settings', () => {
    const popup = Object.assign({}, normal, { role: 'pop-up' });
    assert.equal(I.isEligible(popup, noDialogs), false);
    assert.equal(I.isEligible(Object.assign({}, popup, { type: 'dialog' }), { includeDialogs: true, excludedApps: [] }), false);
    assert.equal(I.windowKey(popup), I.windowKey(normal)); // same identity as the normal window, which is why the role decides
    assert.equal(I.isEligible(normal, noDialogs), true); // role 'browser'
});

test('windows with any other role stay eligible: none, or one that changes on every launch', () => {
    const roles = ['', 'browser', 'xed-window-1760000000-4242-0-host', 'gnome-terminal-window-6f1c2d3e-0b5a-4c7e-9a41-2f8d7e6b5a10'];
    for (const role of roles) assert.equal(I.isEligible(Object.assign({}, normal, { role: role }), noDialogs), true, role);
});

test('excluded apps match case-insensitively as substrings; blank patterns are ignored', () => {
    assert.equal(I.isEligible(normal, { includeDialogs: false, excludedApps: ['FIRE'] }), false);
    assert.equal(I.isEligible(normal, { includeDialogs: false, excludedApps: ['  ', ''] }), true);
});

test('pickEntry returns the newest unclaimed candidate', () => {
    const cands = [{ id: 'a', title: 'x' }, { id: 'b', title: 'y' }];
    assert.equal(I.pickEntry(cands, { title: '', matchByTitle: false, claimed: new Set() }).id, 'a');
    assert.equal(I.pickEntry(cands, { title: '', matchByTitle: false, claimed: new Set(['a']) }).id, 'b');
});

test('pickEntry returns null when there are no candidates or all are claimed', () => {
    assert.equal(I.pickEntry([], { title: '', matchByTitle: false, claimed: new Set() }), null);
    assert.equal(I.pickEntry([{ id: 'a' }], { title: '', matchByTitle: false, claimed: new Set(['a']) }), null);
});

test('class+title mode prefers an exact title match, else the newest candidate', () => {
    const cands = [{ id: 'a', title: 'notes.txt' }, { id: 'b', title: 'todo.txt' }];
    assert.equal(I.pickEntry(cands, { title: 'todo.txt', matchByTitle: true, claimed: new Set() }).id, 'b');
    assert.equal(I.pickEntry(cands, { title: 'other', matchByTitle: true, claimed: new Set() }).id, 'a');
});

const none = new Set();

test('pickEntry prefers a free candidate saved with the same role', () => {
    const cands = [{ id: 'a', role: 'browser' }, { id: 'b', role: 'pop-up' }];
    assert.equal(I.pickEntry(cands, { role: 'pop-up', matchByTitle: false, claimed: none }).id, 'b');
    assert.equal(I.pickEntry(cands, { role: 'browser', matchByTitle: false, claimed: none }).id, 'a');
});

test('pickEntry falls back to the newest free candidate when no role matches or no role is given', () => {
    const cands = [{ id: 'a', role: 'browser' }, { id: 'b', role: 'xed-window-1-2-0-h' }];
    assert.equal(I.pickEntry(cands, { role: 'pop-up', matchByTitle: false, claimed: none }).id, 'a');
    assert.equal(I.pickEntry(cands, { role: 'xed-window-9-9-0-h', matchByTitle: false, claimed: none }).id, 'a');
    assert.equal(I.pickEntry(cands, { matchByTitle: false, claimed: none }).id, 'a');
});

test('pickEntry gives gnome-terminal and xed windows the newest free entry, whatever their per-launch roles', () => {
    const term = [{ id: 'a', role: 'gnome-terminal-window-aaaa' }, { id: 'b', role: 'gnome-terminal-window-bbbb' }];
    assert.equal(I.pickEntry(term, { role: 'gnome-terminal-window-cccc', matchByTitle: false, claimed: none }).id, 'a');
    assert.equal(I.pickEntry(term, { role: 'gnome-terminal-window-dddd', matchByTitle: false, claimed: new Set(['a']) }).id, 'b');
    const xed = [{ id: 'a', role: 'xed-window-1-2-0-h' }, { id: 'b', role: 'xed-window-3-4-0-h' }];
    assert.equal(I.pickEntry(xed, { role: 'xed-window-5-6-0-h', matchByTitle: false, claimed: none }).id, 'a');
});

test('pickEntry skips a claimed candidate with the same role and falls back', () => {
    const cands = [{ id: 'a', role: 'browser' }, { id: 'b', role: 'pop-up' }];
    assert.equal(I.pickEntry(cands, { role: 'pop-up', matchByTitle: false, claimed: new Set(['b']) }).id, 'a');
});

test('pickEntry applies the role preference before the title in class+title mode', () => {
    const cands = [{ id: 'a', role: 'browser', title: 'inbox' }, { id: 'b', role: 'pop-up', title: 'login' }];
    assert.equal(I.pickEntry(cands, { role: 'pop-up', title: 'inbox', matchByTitle: true, claimed: none }).id, 'b');
    const same = [{ id: 'a', role: 'pop-up', title: 'one' }, { id: 'b', role: 'pop-up', title: 'two' }];
    assert.equal(I.pickEntry(same, { role: 'pop-up', title: 'two', matchByTitle: true, claimed: none }).id, 'b');
});

test('pickEntry prefers a free entry that is not minimized', () => {
    const cands = [{ id: 'newest', minimized: true }, { id: 'older', minimized: false }];
    assert.equal(I.pickEntry(cands, { matchByTitle: false, claimed: none }).id, 'older');
});

test('pickEntry keeps a role match ahead of the minimized preference', () => {
    const cands = [{ id: 'a', role: 'x', minimized: false }, { id: 'b', role: 'y', minimized: true }];
    assert.equal(I.pickEntry(cands, { role: 'y', matchByTitle: false, claimed: none }).id, 'b');
});

test('pickEntry falls back to a minimized entry when only minimized entries are free', () => {
    const cands = [{ id: 'a', minimized: true }];
    assert.equal(I.pickEntry(cands, { matchByTitle: false, claimed: none }).id, 'a');
});

test('pickEntry keeps an exact title match ahead of the minimized preference', () => {
    const cands = [{ id: 'a', title: 'one', minimized: false }, { id: 'b', title: 'two', minimized: true }];
    assert.equal(I.pickEntry(cands, { title: 'two', matchByTitle: true, claimed: none }).id, 'b');
});

test('pickEntry follows recency, not the minimized preference, when minimizedMatters is false', () => {
    const cands = [{ id: 'newest', minimized: true }, { id: 'older', minimized: false }];
    assert.equal(I.pickEntry(cands, { matchByTitle: false, claimed: none, minimizedMatters: true }).id, 'older');
    assert.equal(I.pickEntry(cands, { matchByTitle: false, claimed: none, minimizedMatters: false }).id, 'newest');
});

test('pickEntry counts an entry with no minimized field as not minimized', () => {
    const cands = [{ id: 'new', minimized: true }, { id: 'old' }];
    assert.equal(I.pickEntry(cands, { matchByTitle: false, claimed: none }).id, 'old');
});

test('pickEntry with a type returns only entries of that type, and an entry with no type counts as normal', () => {
    const entries = [
        { id: 'd', type: 'dialog', role: '' },
        { id: 'n', type: 'normal', role: '' },
        { id: 'old', role: '' }, // saved before the type was recorded
    ];
    const ctx = type => ({ claimed: new Set(), type: type });
    assert.equal(I.pickEntry(entries, ctx('dialog')).id, 'd');
    assert.equal(I.pickEntry(entries, ctx('normal')).id, 'n');
    assert.equal(I.pickEntry([entries[0], entries[2]], ctx('normal')).id, 'old');
    assert.equal(I.pickEntry([entries[1], entries[2]], ctx('dialog')), null);
});

test('pickEntry without a type does not filter by type', () => {
    const entries = [{ id: 'd', type: 'dialog' }, { id: 'n', type: 'normal' }];
    assert.equal(I.pickEntry(entries, { claimed: new Set() }).id, 'd');
});

// Keys that name the same application in an X11 session and in a Wayland session.
test('equivalentKeys gives the key first, then the keys of the same application in the other session', () => {
    assert.deepEqual(I.equivalentKeys('gnome-terminal|gnome-terminal-server'),
        ['gnome-terminal|gnome-terminal-server', 'gnome-terminal-server|gnome-terminal-server']);
    assert.deepEqual(I.equivalentKeys('gnome-terminal-server|gnome-terminal-server'),
        ['gnome-terminal-server|gnome-terminal-server', 'gnome-terminal|gnome-terminal-server']);
});

test('equivalentKeys of an application with two X11 keys lists both', () => {
    const keys = I.equivalentKeys('org.kde.kate|org.kde.kate');
    assert.equal(keys[0], 'org.kde.kate|org.kde.kate');
    assert.ok(keys.includes('kate|kate-bin') && keys.includes('kate|kate'));
    assert.equal(new Set(keys).size, keys.length);
});

test('equivalentKeys of an unknown key, or no key, is just that key', () => {
    assert.deepEqual(I.equivalentKeys('firefox|other'), ['firefox|other']);
    assert.deepEqual(I.equivalentKeys(null), []);
});

test('every group has distinct keys, all in the lower case form of windowKey, and no key is in two groups', () => {
    const seen = new Set();
    for (const group of I.KEY_GROUPS) {
        assert.ok(group.length >= 2);
        for (const k of group) {
            assert.equal(k, k.toLowerCase());
            assert.match(k, /^[^|]+\|[^|]+$/);
            assert.ok(!seen.has(k), 'duplicate ' + k);
            seen.add(k);
        }
    }
});

// Applications whose X11 key and native Wayland key were both measured on Cinnamon 6.0.5 (Linux Mint 21.3): the application
// started natively and again with GDK_BACKEND=x11. [X11 key, Wayland key].
const MEASURED_PAIRS = [
    ['meld|org.gnome.meld', 'org.gnome.meld|org.gnome.meld'],
    ['drawing|com.github.maoschanz.drawing', 'com.github.maoschanz.drawing|com.github.maoschanz.drawing'],
    ['libreoffice-writer|libreoffice', 'libreoffice-writer|libreoffice-writer'],
    ['libreoffice-calc|libreoffice', 'libreoffice-calc|libreoffice-calc'],
    ['libreoffice-impress|libreoffice', 'libreoffice-impress|libreoffice-impress'],
];
// Same naming as the measured ones, not run: the other LibreOffice programs (the X11 window of every LibreOffice program has the
// instance "libreoffice"), and the KDE applications, whose X11 window is named after the program and whose native Wayland
// window after its desktop file (as for the Kate, Dolphin and Discover pairs above).
const PATTERN_PAIRS = [
    ['libreoffice-draw|libreoffice', 'libreoffice-draw|libreoffice-draw'],
    ['libreoffice-math|libreoffice', 'libreoffice-math|libreoffice-math'],
    ['libreoffice-base|libreoffice', 'libreoffice-base|libreoffice-base'],
    ['okular|okular', 'org.kde.okular|org.kde.okular'],
    ['konsole|konsole', 'org.kde.konsole|org.kde.konsole'],
    ['kwrite|kwrite', 'org.kde.kwrite|org.kde.kwrite'],
    ['ark|ark', 'org.kde.ark|org.kde.ark'],
    ['gwenview|gwenview', 'org.kde.gwenview|org.kde.gwenview'],
    ['kcalc|kcalc', 'org.kde.kcalc|org.kde.kcalc'],
];

test('the measured applications whose X11 and Wayland keys differ are each one group, in both directions', () => {
    for (const [x, w] of MEASURED_PAIRS.concat(PATTERN_PAIRS)) {
        assert.deepEqual(I.equivalentKeys(x), [x, w], x);
        assert.deepEqual(I.equivalentKeys(w), [w, x], w);
    }
});

test('applications whose X11 key and Wayland key are the same need no group', () => {
    // Many applications report the same key in both sessions; a few examples. (Transmission's X11 class differs from its
    // instance only by its capital, which the lower-case key does not keep.)
    for (const key of ['org.gnome.nautilus|org.gnome.nautilus', 'gnome-calculator|gnome-calculator', 'file-roller|file-roller',
        'xreader|xreader', 'xviewer|xviewer', 'pix|pix', 'mousepad|mousepad', 'thunar|thunar', 'gitg|gitg',
        'io.github.celluloid_player.celluloid|io.github.celluloid_player.celluloid', 'transmission-gtk|transmission-gtk'])
        assert.deepEqual(I.equivalentKeys(key), [key], key);
});

test('the properties window of Nemo is not an alias of the Nemo main window', () => {
    assert.deepEqual(I.equivalentKeys('nemo|nemo'), ['nemo|nemo']);
    assert.deepEqual(I.equivalentKeys('nemo|file_properties'), ['nemo|file_properties']);
});

// Learned mapping: entries saved by the same application (its desktop file id) from the other kind of client.
test('learnedCandidates keeps the entries of the same application saved by the other kind of client', () => {
    const entries = [
        { id: 'a', appId: 'app.desktop', client: 'x11' },
        { id: 'b', appId: 'app.desktop', client: 'wayland' },
        { id: 'c', appId: 'other.desktop', client: 'x11' },
        { id: 'd', appId: 'app.desktop' }, // saved before the field existed: an X11 window
        { id: 'e', appId: null, client: 'x11' },
    ];
    assert.deepEqual(I.learnedCandidates(entries, 'app.desktop', 'wayland').map(e => e.id), ['a', 'd']);
    assert.deepEqual(I.learnedCandidates(entries, 'app.desktop', 'x11').map(e => e.id), ['b']);
});

test('learnedCandidates gives nothing without an application id, and never for entries of the same kind of client', () => {
    const entries = [{ id: 'a', appId: 'app.desktop', client: 'x11' }];
    assert.deepEqual(I.learnedCandidates(entries, null, 'wayland'), []);
    assert.deepEqual(I.learnedCandidates(entries, '', 'wayland'), []);
    assert.deepEqual(I.learnedCandidates(entries, 'app.desktop', 'x11'), []); // an X11 user is never affected
});
