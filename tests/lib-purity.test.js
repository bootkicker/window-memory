const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const libDir = path.join(__dirname, '..', 'files', 'window-memory@bootkicker', 'lib');
// Neither module.exports nor require: Cinnamon 6.0 collects the top-level names of a file, Cinnamon 6.8 imports its
// top-level var and function declarations.
const FORBIDDEN = [
    /\bimports\./, /\brequire\s*\(/, /\bmodule\.exports\b/, /\bglobal\./, /\bglobalThis\b/, /\bprocess\./, /\bBuffer\b/,
    /\b__dirname\b/, /\b__filename\b/, /(^|[^.\w$])(setTimeout|setInterval)\s*\(/m,
];

test('lib/ uses neither GJS/Cinnamon modules nor Node-only APIs', () => {
    const files = fs.readdirSync(libDir).filter(f => f.endsWith('.js'));
    assert.deepEqual(files.sort(), ['geometry.js', 'identity.js', 'pick.js', 'safety.js', 'startupPick.js', 'store.js', 'timing.js']);
    for (const f of files) {
        const src = fs.readFileSync(path.join(libDir, f), 'utf8');
        for (const re of FORBIDDEN) assert.doesNotMatch(src, re, f + ' matches ' + re);
    }
});
