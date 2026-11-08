const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'files', 'window-memory@bootkicker');

test('metadata uuid matches the folder name and required keys exist', () => {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
    assert.equal(meta.uuid, 'window-memory@bootkicker');
    assert.equal(path.basename(dir), meta.uuid);
    for (const key of ['name', 'description']) assert.ok(meta[key], key);
    assert.ok(Array.isArray(meta['cinnamon-version']), 'cinnamon-version must be an array');
});

test('metadata carries the version that the settings window shows, in step with package.json', () => {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.match(meta.version, /^\d+\.\d+\.\d+$/);
    assert.equal(meta.version, pkg.version);
    assert.equal(meta.author, 'bootkicker', 'the other keys are kept');
});

test('metadata has the project home page, so that Cinnamon does not log a missing "url"', () => {
    // Cinnamon lists "url" among the nice-to-have properties (ui/extension.js:104) and warns without it (:355).
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
    assert.equal(meta.url, 'https://github.com/bootkicker/window-memory');
});
