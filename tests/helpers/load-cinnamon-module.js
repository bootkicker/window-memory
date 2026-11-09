// Loads a file of the extension the way Cinnamon does, since Node's require() returns {} for a file without
// module.exports.
//
// '6.0': Cinnamon 6.0 to 6.6 (misc/fileUtils.js requireModule, createExports). The source is wrapped in a function of
//   (require, exports, module, __meta, __dirname, __filename). When no line matches /^module\.exports(\.name)?\s*=/m, an
//   `exports.NAME = ...` is appended for every top-level const, var, let, function or class NAME (except the names of
//   native imports), and the function returns module.exports. require('./lib/x') loads <extension dir>/lib/x.js the same
//   way and serves it from a cache keyed by path, so a test and the extension share one object per lib file.
// '6.8': Cinnamon 6.8's native importer (ui/extension.js:519 at tag 6.8.0): the file is evaluated with `module` and
//   `exports` undefined, and only its top-level `var` and `function` declarations are exported.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EXT_DIR = path.join(__dirname, '..', '..', 'files', 'window-memory@bootkicker');
const EXTENSION = path.join(EXT_DIR, 'extension.js');

// misc/fileUtils.js:7-21 (6.0.5); the GI namespaces are the keys of imports.gi when the mock is installed.
const IMPORT_NAMES = ['mainloop', 'jsUnit', 'format', 'signals', 'lang', 'tweener', 'overrides', 'gettext', 'coverage',
    'package', 'cairo', 'byteArray', 'cairoNative'];

const cache = new Map();

function giNames() {
    const gi = globalThis.imports && globalThis.imports.gi;
    return gi ? Object.keys(gi) : [];
}

// The require() Cinnamon 6.0 gives a file of the extension: relative paths resolve against the extension folder, even from
// inside lib/ (misc/fileUtils.js:241-267).
function cinnamonRequire(dir) {
    return function require(p) {
        if (p.slice(-3) !== '.js') p += '.js';
        if (p[0] === '.' || p[0] !== '/') p = path.join(dir, p.replace(/\.\//g, ''));
        return loadCinnamonModule(p, { mode: '6.0' });
    };
}

function load60(file, src, opts) {
    let js = `'use strict';${src};`;
    const exportsRegex = /^module\.exports(\.[a-zA-Z0-9_$]+)?\s*=/m;
    const varRegex = /^(?:'use strict';){0,}(const|var|let|function|class)\s+([a-zA-Z0-9_$]+)/gm;
    if (!exportsRegex.test(js)) {
        const gi = giNames();
        let match;
        while ((match = varRegex.exec(js)) != null) {
            if (match.index === varRegex.lastIndex) varRegex.lastIndex++;
            if (match[2] && IMPORT_NAMES.indexOf(match[2].toLowerCase()) === -1 && gi.indexOf(match[2]) === -1)
                js += `exports.${match[2]} = typeof ${match[2]} !== 'undefined' ? ${match[2]} : null;`;
        }
    }
    js += 'return module.exports;';
    const exports = {};
    const module = { exports: exports };
    const req = opts.require || cinnamonRequire(EXT_DIR);
    return new Function('require', 'exports', 'module', '__meta', '__dirname', '__filename', js)
        .call(exports, req, exports, module, opts.meta, EXT_DIR, path.basename(file));
}

function load68(file, src, opts) {
    const names = [...src.matchAll(/^(?:var|function)\s+([a-zA-Z0-9_$]+)/gm)].map(m => m[1]);
    const body = src + '\n;return {' + names.map(n => `${JSON.stringify(n)}: ${n}`).join(', ') + '};';
    // globalThis.require exists in 6.8 (ui/extension.js:366) but logs a deprecation; a test passes its own.
    const req = opts.require || function require(p) { throw new Error('require() called on the 6.8 path: ' + p); };
    return new Function('require', 'module', 'exports', body)(req, undefined, undefined);
}

// opts.mode: '6.0' (default) or '6.8'. opts.fresh: load again instead of serving the cached module (the extension tests
// load extension.js anew for each test). opts.require: the require() the file sees.
function loadCinnamonModule(file, opts) {
    opts = opts || {};
    const mode = opts.mode || '6.0';
    if (mode !== '6.0' && mode !== '6.8') throw new Error('unknown mode ' + mode);
    file = path.resolve(file);
    const key = mode + ':' + file;
    if (!opts.fresh && !opts.require && cache.has(key)) return cache.get(key);
    const src = fs.readFileSync(file, 'utf8');
    const loaded = mode === '6.0' ? load60(file, src, opts) : load68(file, src, opts);
    if (!opts.require) cache.set(key, loaded);
    return loaded;
}

// A file of lib/ by its importer name, e.g. lib('store') or lib('startupPick', '6.8').
function lib(name, mode) {
    return loadCinnamonModule(path.join(EXT_DIR, 'lib', name + '.js'), { mode: mode });
}

// extension.js, loaded anew each time.
function loadExtension(opts) {
    return loadCinnamonModule(EXTENSION, Object.assign({ fresh: true }, opts || {}));
}

module.exports = { loadCinnamonModule, cinnamonRequire, lib, loadExtension, EXT_DIR, EXTENSION };
