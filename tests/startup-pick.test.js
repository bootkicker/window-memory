// SPDX-License-Identifier: GPL-3.0-or-later
// lib/startup-pick.js: the pure logic of "Pick a window to start at login": a desktop Exec value from an argument list,
// the choice between an application (desktop file) and the form (command), and the text handed to the settings tab.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { quoteArgs, classify, encodeResult } = require(path.join(__dirname, '..', 'files', 'window-memory@bootkicker', 'lib', 'startup-pick.js'));

// Splits a string the way a shell does, with no expansion of anything that is not quoted: prints each word NUL-ended.
function shellSplit(text) {
    const run = spawnSync('sh', ['-c', 'for a in ' + text + '; do printf "%s\\0" "$a"; done'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.split('\0').slice(0, -1);
}

test('quoteArgs gives a string that a shell splits back to the same arguments', () => {
    const argv = ['xterm', '-e', 'sh -c "x; y"'];
    assert.deepEqual(shellSplit(quoteArgs(argv)), argv);
    const odd = ['a b', "it's", 'back\\slash', 'dollar$HOME', 'tick`id`', 'star*', 'semi;colon', '', 'tab\there', '--opt=a b', '~', '#x', 'a&b|c', '(x)', '<>'];
    assert.deepEqual(shellSplit(quoteArgs(odd)), odd);
});

test('quoteArgs leaves plain arguments bare and quotes only the ones that need it, as a desktop Exec value', () => {
    assert.equal(quoteArgs(['nemo', '--no-desktop', '/usr/share/x-1.2/a_b']), 'nemo --no-desktop /usr/share/x-1.2/a_b');
    assert.equal(quoteArgs(['sh', '-c', 'echo hi']), 'sh -c "echo hi"');
    assert.equal(quoteArgs(['x', '']), 'x ""');
    // Inside double quotes the Desktop Entry spec wants a backslash before ", `, $ and \; a % is written %% (field codes).
    assert.equal(quoteArgs(['x', 'a"b c']), 'x "a\\"b c"');
    assert.equal(quoteArgs(['x', '$a b']), 'x "\\$a b"');
    assert.equal(quoteArgs(['x', '100%']), 'x 100%%');
    assert.equal(quoteArgs(['x', '50% off']), 'x "50%% off"');
    assert.equal(quoteArgs([]), '');
});

test('classify: a window with a desktop file is an application', () => {
    assert.deepEqual(classify({ desktopFile: '/usr/share/applications/nemo.desktop', name: 'Files', argv: ['nemo'] }),
        { kind: 'app', desktopFile: '/usr/share/applications/nemo.desktop', name: 'Files' });
    // No name from the application: the desktop file's name stands in.
    assert.deepEqual(classify({ desktopFile: '/usr/share/applications/nemo.desktop', name: null, argv: null }),
        { kind: 'app', desktopFile: '/usr/share/applications/nemo.desktop', name: 'nemo' });
});

test('classify: no desktop file (null or empty) is the form, with the command from the arguments', () => {
    for (const desktopFile of [null, '', undefined]) {
        assert.deepEqual(classify({ desktopFile: desktopFile, name: 'XTerm', argv: ['xterm', '-e', 'sh -c "x; y"'] }),
            { kind: 'form', name: 'XTerm', command: 'xterm -e "sh -c \\"x; y\\""' });
    }
    assert.deepEqual(classify({ desktopFile: null, name: null, argv: ['/usr/bin/xterm', '-e', 'top'] }),
        { kind: 'form', name: 'xterm', command: '/usr/bin/xterm -e top' });
});

test('classify: no arguments (null or empty) give an empty command, and the name falls back to empty', () => {
    assert.deepEqual(classify({ desktopFile: null, name: 'Thing', argv: null }), { kind: 'form', name: 'Thing', command: '' });
    assert.deepEqual(classify({ desktopFile: null, name: null, argv: null }), { kind: 'form', name: '', command: '' });
    assert.deepEqual(classify({ desktopFile: null, name: '', argv: [] }), { kind: 'form', name: '', command: '' });
    assert.deepEqual(classify({ desktopFile: null, name: null, argv: [''] }), { kind: 'form', name: '', command: '""' });
    assert.deepEqual(classify({}), { kind: 'form', name: '', command: '' });
    assert.deepEqual(classify(null), { kind: 'form', name: '', command: '' });
});

test('encodeResult is JSON text the tab parses: v 1, the stamp, then the result', () => {
    const app = { kind: 'app', desktopFile: '/usr/share/applications/nemo.desktop', name: 'Nemo' };
    assert.equal(encodeResult(app, 42), '{"v":1,"stamp":42,"kind":"app","desktopFile":"/usr/share/applications/nemo.desktop","name":"Nemo"}');
    const form = { kind: 'form', name: 'Tëst "q"', command: 'a "b c"' };
    const text = encodeResult(form, 1730000000000);
    assert.deepEqual(JSON.parse(text), { v: 1, stamp: 1730000000000, kind: 'form', name: 'Tëst "q"', command: 'a "b c"' });
    assert.equal(text, '{"v":1,"stamp":1730000000000,"kind":"form","name":"Tëst \\"q\\"","command":"a \\"b c\\""}');
    // A different stamp is a different value even for the same pick: the tab sees a change.
    assert.notEqual(encodeResult(app, 1), encodeResult(app, 2));
});
