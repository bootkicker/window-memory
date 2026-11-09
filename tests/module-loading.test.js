// How Cinnamon loads extension.js and lib/: with require() on Cinnamon 6.0 to 6.6 (no getCurrentExtension() there), and
// with the native importer of getCurrentExtension().imports on Cinnamon 6.8, which deprecates require() and module.exports.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { install } = require('./helpers/cinnamon-mock.js');
const { loadExtension, cinnamonRequire, lib, EXT_DIR, EXTENSION } = require('./helpers/load-cinnamon-module.js');

const LIB_DIR = path.join(EXT_DIR, 'lib');
const SRC = fs.readFileSync(EXTENSION, 'utf8');

// The lib modules extension.js loads: its variable name -> the importer name of the file in lib/.
function loaderModules() {
    const found = [...SRC.matchAll(/^const (\w+) = libModule\('(\w+)'\);$/gm)].map(m => [m[1], m[2]]);
    return new Map(found);
}

function shippedJs(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
        const p = path.join(dir, d.name);
        if (d.isDirectory()) return shippedJs(p);
        return d.name.endsWith('.js') ? [p] : [];
    });
}

function runLifecycle(ext, env) {
    for (const name of ['init', 'enable', 'disable']) assert.equal(typeof ext[name], 'function', name);
    ext.init({ uuid: 'window-memory@bootkicker' });
    const callbacks = ext.enable();
    assert.equal(typeof callbacks, 'object');
    ext.disable();
    assert.equal(env.errors, undefined);
}

test('extension.js loads all seven lib modules through its loader, each file under its importer name', () => {
    const modules = loaderModules();
    assert.deepEqual([...modules.keys()], ['Geometry', 'Identity', 'Pick', 'Safety', 'StartupPick', 'Store', 'Timing']);
    const files = fs.readdirSync(LIB_DIR).filter(f => f.endsWith('.js')).map(f => f.slice(0, -3)).sort();
    assert.deepEqual([...modules.values()].sort(), files);
    for (const name of modules.values()) assert.match(name, /^[A-Za-z_$][\w$]*$/, name + ' is a plain identifier');
});

test('Cinnamon 6.0 path: without getCurrentExtension, extension.js loads its lib modules with require() and runs', () => {
    const env = install();
    assert.equal(typeof globalThis.imports.ui.extension.getCurrentExtension, 'undefined');
    const requested = [];
    const req60 = cinnamonRequire(EXT_DIR);
    const ext = loadExtension({ mode: '6.0', require: p => { requested.push(p); return req60(p); } });
    assert.deepEqual(requested, [...loaderModules().values()].map(n => './lib/' + n));
    runLifecycle(ext, env);
});

test('Cinnamon 6.8 path: with getCurrentExtension, extension.js loads lib from its importer without calling require()', () => {
    const env = install();
    const taken = [];
    const libImporter = {};
    for (const name of loaderModules().values()) {
        Object.defineProperty(libImporter, name, { get() { taken.push(name); return lib(name, '6.8'); } });
    }
    globalThis.imports.ui.extension = { getCurrentExtension: () => ({ imports: { lib: libImporter } }) };
    let ext;
    assert.doesNotThrow(() => {
        ext = loadExtension({ mode: '6.8', require: p => { throw new Error('require() called: ' + p); } });
    });
    assert.deepEqual(taken, [...loaderModules().values()]);
    assert.deepEqual(Object.keys(ext).filter(k => ['init', 'enable', 'disable'].includes(k)).sort(), ['disable', 'enable', 'init']);
    runLifecycle(ext, env);
});

test('Cinnamon 6.8 exports every name extension.js uses from each lib module (top-level var or function)', () => {
    assert.equal(loaderModules().size, 7);
    for (const [variable, name] of loaderModules()) {
        const used = [...new Set([...SRC.matchAll(new RegExp('\\b' + variable + '\\.(\\w+)', 'g'))].map(m => m[1]))];
        assert.ok(used.length > 0, variable + ' is used');
        const mod = lib(name, '6.8');
        for (const member of used) assert.notEqual(mod[member], undefined, 'lib/' + name + '.js exports ' + member);
    }
});

test('Cinnamon 6.0 exports every name that Cinnamon 6.8 exports from each lib module', () => {
    assert.equal(loaderModules().size, 7);
    for (const name of loaderModules().values()) {
        const mod60 = lib(name, '6.0');
        for (const key of Object.keys(lib(name, '6.8'))) assert.equal(typeof mod60[key], typeof lib(name, '6.8')[key], name + '.' + key);
    }
});

test('no shipped JS file uses module.exports, and require( appears only in the loader\'s fallback', () => {
    const files = shippedJs(EXT_DIR);
    assert.ok(files.includes(EXTENSION) && files.length >= 8);
    const requireLines = [];
    for (const f of files) {
        const src = fs.readFileSync(f, 'utf8');
        assert.doesNotMatch(src, /\bmodule\.exports\b/, path.relative(EXT_DIR, f));
        src.split('\n').forEach((line, i) => {
            if (/\brequire\s*\(/.test(line)) requireLines.push(path.relative(EXT_DIR, f) + ':' + (i + 1) + ': ' + line.trim());
        });
    }
    assert.equal(requireLines.length, 1, requireLines.join('\n'));
    assert.match(requireLines[0], /^extension\.js:\d+: .*require\('\.\/lib\/' \+ name\)/);
});

test('nothing at the top level of extension.js reads module or exports', () => {
    const topLevel = SRC.split('\n').filter(line => /^\S/.test(line) && !/^\s*\/\//.test(line));
    for (const line of topLevel) assert.doesNotMatch(line, /\b(module|exports)\b/, line);
});
