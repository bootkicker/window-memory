#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Reports which Cinnamon and Muffin symbols the extension uses are missing in a given Cinnamon release.
//
//   node scripts/api-watch.js <cinnamon-js-dir> <muffin-headers-dir> [<extension-dir>]
//
// <cinnamon-js-dir>      the js/ tree of Cinnamon (installed: /usr/share/cinnamon/js; a release: js/ of the repository at a tag).
// <muffin-headers-dir>   Muffin's public headers (src/meta/*.h of a tag). A folder that does not exist is allowed: every
//                        symbol that needs the headers is then UNKNOWN, and a message says so.
// <extension-dir>        optional, for tests: the folder with extension.js and lib/. Default: the one of this repository.
//
// It scans extension.js and lib/*.js for Meta.X, Meta.X.Y, Main.x(.y), global.x(.y), Cinnamon.X(.Y), Settings.X and
// SignalManager.X, and for the methods called as win.<method>( (the window variable of extension.js). Comments are skipped.
// One line per distinct symbol, sorted: found, MISSING or UNKNOWN, then a Summary line. The exit code is always 0: it reports,
// it does not gate anything.
//
// The check is a TEXT SEARCH over the sources, so it can miss or over-match: a name that only appears in a comment or in
// another object counts as found; a member added by a base class or by the native side is not seen. Where the text
// cannot tell, the answer is UNKNOWN (check it by hand), never MISSING:
// - Meta.<snake_case> and win.<method>: `meta_<name>` and `meta_window_<method>` in the headers. Meta.<Name> and
//   Meta.<Name>.<method>: `Meta<Name>` and `meta_<name>_<method>`. A constant, Meta.<Enum>.<NAME>, is looked up as
//   META_<ENUM>_<NAME> (also without the _TYPE or _FLAGS ending of the enum); it is found, or UNKNOWN. Version numbers and
//   other upper-case members are UNKNOWN.
// - Main.<name>: the word in ui/main.js. Main.<name>.<sub>: MISSING if <name> is, UNKNOWN when <sub> does not appear in the
//   tree (it can belong to a native object).
// - Settings.<Name>: the word in ui/settings.js. SignalManager.<Name>: the word in misc/signalManager.js.
// - global.* and Cinnamon.*: mostly native (C) members, which the js tree defines nowhere. Found when the tree uses the same
//   text (global.logWarning is defined in the tree), otherwise UNKNOWN.
// - win.connect, disconnect and the other GObject methods are not Muffin's and are not listed.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOTS = ['Meta', 'Main', 'global', 'Cinnamon', 'Settings', 'SignalManager'];
const GOBJECT_METHODS = new Set(['connect', 'connect_after', 'disconnect', 'disconnect_by_func', 'emit', 'notify', 'freeze_notify',
    'thaw_notify', 'get_property', 'set_property', 'bind_property', 'ref', 'unref']);

// The .js files below dir (or the .h files for headers), in one string; null when dir is not a readable folder.
function readTree(dir, ext) {
    let st;
    try {
        st = fs.statSync(dir);
    } catch (e) {
        return null;
    }
    if (!st.isDirectory()) return null;
    const out = [];
    const walk = d => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith(ext)) out.push(fs.readFileSync(p, 'utf8'));
        }
    };
    walk(dir);
    return out.length > 0 ? out.join('\n') : null;
}

function readFileOrNull(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch (e) {
        return null;
    }
}

const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[\s;{}(])\/\/.*$/gm, '$1');

// The symbols used by the sources: a Set of 'Meta.later_add', 'Main.layoutManager.monitors', 'win.get_frame_rect'.
function extractSymbols(sources) {
    const symbols = new Set();
    const pathRe = new RegExp('(?<![\\w.$])(' + ROOTS.join('|') + ')((?:\\.[A-Za-z_][A-Za-z0-9_]*){1,3})', 'g');
    const winRe = /(?<![\w.$])win\.([A-Za-z_][A-Za-z0-9_]*)\(/g;
    for (const raw of sources) {
        const text = stripComments(raw);
        let m;
        while ((m = pathRe.exec(text)) !== null) {
            const parts = m[2].slice(1).split('.');
            const cut = parts.indexOf('prototype');
            const names = (cut >= 0 ? parts.slice(0, cut) : parts).slice(0, 2);
            if (names.length > 0) symbols.add([m[1], ...names].join('.'));
        }
        while ((m = winRe.exec(text)) !== null) {
            if (!GOBJECT_METHODS.has(m[1])) symbols.add('win.' + m[1]);
        }
    }
    return symbols;
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasWord = (text, word) => new RegExp('(?<![A-Za-z0-9_])' + escapeRe(word) + '(?![A-Za-z0-9_])').test(text);
const hasText = (text, s) => text.includes(s);
const snake = name => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const isCamel = name => /^[A-Z][a-z0-9]/.test(name);
const isUpper = name => /^[A-Z][A-Z0-9_]*$/.test(name);

// The status of one symbol: 'found', 'MISSING' or 'UNKNOWN'. headers and js are the text of the trees, or null.
function classify(symbol, headers, js, jsMain, jsSettings, jsSignals) {
    const [root, a, b] = symbol.split('.');
    const needJs = text => (text === null ? 'UNKNOWN' : null);
    const inHeaders = word => (hasWord(headers, word) ? 'found' : 'MISSING');

    if (root === 'win') {
        return headers === null ? 'UNKNOWN' : inHeaders('meta_window_' + a);
    }
    if (root === 'Meta') {
        if (headers === null) return 'UNKNOWN';
        if (b === undefined) {
            if (isUpper(a)) return 'UNKNOWN';
            if (isCamel(a)) return inHeaders('Meta' + a);
            return inHeaders('meta_' + a);
        }
        if (isCamel(a) && isUpper(b)) {
            const enumName = snake(a).toUpperCase();
            const bases = [enumName, enumName.replace(/_(TYPE|FLAGS)$/, '')];
            if (bases.some(base => hasWord(headers, 'META_' + base + '_' + b))) return 'found';
            return hasWord(headers, 'Meta' + a) ? 'UNKNOWN' : 'MISSING';
        }
        if (isCamel(a)) return inHeaders('meta_' + snake(a) + '_' + b);
        return 'UNKNOWN';
    }
    if (root === 'Main') {
        const text = jsMain || js;
        if (needJs(text)) return 'UNKNOWN';
        if (!hasWord(text, a)) return 'MISSING';
        if (b === undefined) return 'found';
        return hasWord(js || text, b) ? 'found' : 'UNKNOWN';
    }
    if (root === 'Settings' || root === 'SignalManager') {
        const text = (root === 'Settings' ? jsSettings : jsSignals) || js;
        if (needJs(text)) return 'UNKNOWN';
        return hasWord(text, a) ? 'found' : 'MISSING';
    }
    // global and Cinnamon: native members are not in the js tree.
    if (js === null) return 'UNKNOWN';
    return hasText(js, symbol) ? 'found' : 'UNKNOWN';
}

function scanExtension(extDir) {
    const sources = [];
    const main = readFileOrNull(path.join(extDir, 'extension.js'));
    if (main !== null) sources.push(main);
    const lib = path.join(extDir, 'lib');
    if (fs.existsSync(lib)) {
        for (const f of fs.readdirSync(lib).filter(n => n.endsWith('.js')).sort()) {
            sources.push(fs.readFileSync(path.join(lib, f), 'utf8'));
        }
    }
    return sources;
}

function main(argv) {
    if (argv.length < 2) {
        process.stderr.write('Usage: node scripts/api-watch.js <cinnamon-js-dir> <muffin-headers-dir>\n');
        return;
    }
    const [jsDir, headersDir] = argv;
    const extDir = argv[2] || path.join(__dirname, '..', 'files', 'window-memory@bootkicker');
    const js = readTree(jsDir, '.js');
    const headers = readTree(headersDir, '.h');
    if (js === null) process.stderr.write(`api-watch: no .js files in ${jsDir}: the symbols that need the Cinnamon js tree are UNKNOWN.\n`);
    if (headers === null) process.stderr.write(`api-watch: no .h files in ${headersDir}: the symbols that need the Muffin headers are UNKNOWN.\n`);
    const jsMain = readFileOrNull(path.join(jsDir, 'ui', 'main.js'));
    const jsSettings = readFileOrNull(path.join(jsDir, 'ui', 'settings.js'));
    const jsSignals = readFileOrNull(path.join(jsDir, 'misc', 'signalManager.js'));

    const symbols = [...extractSymbols(scanExtension(extDir))].sort();
    const counts = { found: 0, MISSING: 0, UNKNOWN: 0 };
    const lines = symbols.map(s => {
        const status = classify(s, headers, js, jsMain, jsSettings, jsSignals);
        counts[status]++;
        return status.padEnd(7) + ' ' + s;
    });
    process.stdout.write(lines.join('\n') + (lines.length > 0 ? '\n' : ''));
    process.stdout.write(`Summary: ${counts.found} found, ${counts.MISSING} MISSING, ${counts.UNKNOWN} UNKNOWN\n`);
}

main(process.argv.slice(2));
