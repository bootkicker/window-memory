const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const libDir = path.join(__dirname, '..', 'files', 'window-memory@bootkicker', 'lib');
// module.exports is allowed: Cinnamon's loader provides `module` (misc/fileUtils.js:155-157).
const FORBIDDEN = [
    /\bimports\./, /\brequire\s*\(/, /\bglobal\./, /\bglobalThis\b/, /\bprocess\./, /\bBuffer\b/,
    /\b__dirname\b/, /\b__filename\b/, /(^|[^.\w$])(setTimeout|setInterval)\s*\(/m,
];

test('lib/ uses neither GJS/Cinnamon modules nor Node-only APIs', () => {
    const files = fs.readdirSync(libDir).filter(f => f.endsWith('.js'));
    assert.deepEqual(files.sort(), ['geometry.js', 'identity.js', 'pick.js', 'safety.js', 'startup-pick.js', 'store.js', 'timing.js']);
    for (const f of files) {
        const src = fs.readFileSync(path.join(libDir, f), 'utf8');
        for (const re of FORBIDDEN) assert.doesNotMatch(src, re, f + ' matches ' + re);
    }
});
