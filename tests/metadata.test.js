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

test('info.json names the licence of the package and keeps the author', () => {
    const info = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'info.json'), 'utf8'));
    assert.equal(info.license, 'GPL-3.0-or-later');
    assert.equal(info.author, 'bootkicker');
});

test('the licence ships in the package from the repository LICENSE, not from a copy in files/', () => {
    const pkg = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'package.sh'), 'utf8');
    assert.match(pkg, /cp "\$ROOT\/LICENSE" "\$OUT\/files\/\$UUID\/LICENSE"/);
    assert.ok(!fs.existsSync(path.join(dir, 'LICENSE')), 'no LICENSE inside files/ in the repository');
});

// The Spices store runs the linuxmint/github-actions pattern checker on every pull request
// (pattern-checker/patterns/gtk-gdk.yml "has_icon", file-paths.yml "hardcoded_data_dir").
test('no file of the extension calls has_icon(), which skips the legacy icon folders; lookup_icon is used instead', () => {
    for (const f of fs.readdirSync(dir).filter(f => /\.(py|js)$/.test(f))) {
        const src = fs.readFileSync(path.join(dir, f), 'utf8');
        assert.doesNotMatch(src, /\bhas_icon\s*\(/, f);
    }
    for (const f of ['pick_button.py', 'forget_button.py', 'startup_list.py']) {
        assert.match(fs.readFileSync(path.join(dir, f), 'utf8'), /\.lookup_icon\(/, f);
    }
});

test('no JavaScript file of the extension hardcodes .local/share; GLib.get_user_data_dir() is used instead', () => {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'))
        .concat(fs.readdirSync(path.join(dir, 'lib')).filter(f => f.endsWith('.js')).map(f => path.join('lib', f)));
    for (const f of files) {
        const src = fs.readFileSync(path.join(dir, f), 'utf8');
        assert.doesNotMatch(src, /['"]\/?\.(local\/share|local['"/]+share)/, f);
    }
});
