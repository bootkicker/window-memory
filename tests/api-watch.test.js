const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, '..', 'scripts', 'api-watch.js');

// A tiny stand-in for a Cinnamon release: a js tree, a folder of Muffin headers, and an extension that uses a few symbols.
function makeFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-watch-'));
    const write = (rel, text) => {
        const file = path.join(root, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
    };
    write('js/ui/main.js', 'var layoutManager = null;\nfunction notify() {}\n');
    write('js/ui/settings.js', 'class ExtensionSettings {}\n');
    write('js/misc/signalManager.js', 'class SignalManager {}\n');
    write('js/ui/other.js', 'const w = global.logWarning;\n');
    write('headers/window.h', [
        'typedef struct _MetaWindow MetaWindow;',
        'void meta_window_get_frame_rect (MetaWindow *window, void *rect);',
        'void meta_later_add (int when);',
        'typedef enum { META_MAXIMIZE_BOTH = 3 } MetaMaximizeFlags;',
        '',
    ].join('\n'));
    write('ext/extension.js', [
        '// Main.inComment is only in a comment',
        'Meta.later_add(1, cb);',
        'Meta.vanished_call();',
        'Meta.Window;',
        'Meta.MaximizeFlags.BOTH;',
        'Meta.MAJOR_VERSION;',
        'Main.layoutManager.monitors;',
        'Main.gone;',
        'Settings.ExtensionSettings;',
        'SignalManager.SignalManager;',
        'global.logWarning("x");',
        'global.display;',
        'win.get_frame_rect();',
        'win.vanished();',
        'win.connect("x", f);',
        '',
    ].join('\n'));
    write('ext/lib/more.js', 'Main.layoutManager;\nwin.get_frame_rect();\n');
    return root;
}

function run(root, headers, extra = ['--ext']) {
    const args = [script, path.join(root, 'js'), headers];
    if (extra[0] === '--ext') args.push(path.join(root, 'ext'));
    return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

const lines = out => out.split('\n');
const has = (out, status, symbol) => lines(out).some(l => l.trim().split(/\s+/).join(' ') === status + ' ' + symbol);

test('api-watch: a present symbol is found, an absent one is MISSING, an unreliable one is UNKNOWN', () => {
    const root = makeFixture();
    const r = run(root, path.join(root, 'headers'));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(has(r.stdout, 'found', 'Meta.later_add'), r.stdout);
    assert.ok(has(r.stdout, 'found', 'Meta.Window'), r.stdout);
    assert.ok(has(r.stdout, 'found', 'Meta.MaximizeFlags.BOTH'), r.stdout);
    assert.ok(has(r.stdout, 'MISSING', 'Meta.vanished_call'), r.stdout);
    assert.ok(has(r.stdout, 'found', 'win.get_frame_rect'), r.stdout);
    assert.ok(has(r.stdout, 'MISSING', 'win.vanished'), r.stdout);
    assert.ok(has(r.stdout, 'found', 'Main.layoutManager'), r.stdout);
    assert.ok(has(r.stdout, 'MISSING', 'Main.gone'), r.stdout);
    assert.ok(has(r.stdout, 'found', 'Settings.ExtensionSettings'), r.stdout);
    assert.ok(has(r.stdout, 'found', 'SignalManager.SignalManager'), r.stdout);
    assert.ok(has(r.stdout, 'found', 'global.logWarning'), r.stdout);
    // A member of the native side that no script of the tree uses cannot be checked: UNKNOWN, never MISSING.
    assert.ok(has(r.stdout, 'UNKNOWN', 'global.display'), r.stdout);
    assert.ok(has(r.stdout, 'UNKNOWN', 'Meta.MAJOR_VERSION'), r.stdout);
    // A sub-member of a Main member that is there is UNKNOWN when the tree does not mention it.
    assert.ok(has(r.stdout, 'UNKNOWN', 'Main.layoutManager.monitors'), r.stdout);
    // Comments are not scanned, the GObject methods are not Muffin's, and a symbol is listed once.
    assert.ok(!r.stdout.includes('inComment'), r.stdout);
    assert.ok(!r.stdout.includes('win.connect'), r.stdout);
    assert.equal(lines(r.stdout).filter(l => l.endsWith(' win.get_frame_rect')).length, 1, r.stdout);
});

test('api-watch: the last line counts the three kinds, and the symbols are sorted', () => {
    const root = makeFixture();
    const r = run(root, path.join(root, 'headers'));
    const all = lines(r.stdout).filter(l => l.trim() !== '');
    const rows = all.slice(0, -1);
    const count = s => rows.filter(l => l.trim().startsWith(s + ' ')).length;
    assert.equal(all[all.length - 1], `Summary: ${count('found')} found, ${count('MISSING')} MISSING, ${count('UNKNOWN')} UNKNOWN`);
    const names = rows.map(l => l.trim().split(/\s+/)[1]);
    assert.deepEqual(names, [...names].sort());
});

test('api-watch: a folder of headers that does not exist makes the Muffin symbols UNKNOWN, with a message, and exits 0', () => {
    const root = makeFixture();
    const r = run(root, path.join(root, 'no-such-headers'));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /headers/i);
    assert.ok(has(r.stdout, 'UNKNOWN', 'Meta.later_add'), r.stdout);
    assert.ok(has(r.stdout, 'UNKNOWN', 'win.vanished'), r.stdout);
    assert.ok(has(r.stdout, 'MISSING', 'Main.gone'), r.stdout);
});

test('api-watch: without a third argument it reads the extension of the repository and still exits 0', () => {
    const root = makeFixture();
    const r = spawnSync(process.execPath, [script, path.join(root, 'js'), path.join(root, 'headers')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(has(r.stdout, 'found', 'Settings.ExtensionSettings'), r.stdout);
    assert.match(r.stdout, /^Summary: \d+ found, \d+ MISSING, \d+ UNKNOWN$/m);
});

test('api-watch: without the two folders it prints a usage line and exits 0', () => {
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /Usage/);
});
