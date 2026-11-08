#!/usr/bin/env node
// Sets the version of Window Memory in the two files that carry it, which must agree (tests/metadata.test.js):
//   files/window-memory@bootkicker/metadata.json   the version Cinnamon and the settings window show
//   package.json                                   the version of the repository
// Usage: node scripts/set-version.js <X.Y.Z> [--root <folder>]   (scripts/release.sh calls it)
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const UUID = 'window-memory@bootkicker';

function die(message) {
    process.stderr.write(`set-version: ${message}\n`);
    process.exit(1);
}

const args = process.argv.slice(2);
let root = path.join(__dirname, '..');
const rootAt = args.indexOf('--root');
if (rootAt !== -1) {
    root = args[rootAt + 1];
    if (!root) die('--root needs a folder');
    args.splice(rootAt, 2);
}
const version = args[0] || '';
if (args.length !== 1 || !/^\d+\.\d+\.\d+$/.test(version)) die(`usage: set-version.js <X.Y.Z> [--root <folder>] (got '${args.join(' ')}')`);

const metaPath = path.join(root, 'files', UUID, 'metadata.json');
const pkgPath = path.join(root, 'package.json');
// Read both before writing either, so a missing or broken file changes nothing.
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
meta.version = version;
pkg.version = version;
fs.writeFileSync(metaPath, JSON.stringify(meta, null, 4) + '\n');
fs.writeFileSync(pkgPath, JSON.stringify(pkg) + '\n');
