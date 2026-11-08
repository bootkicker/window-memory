#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Writes files/window-memory@bootkicker/po/window-memory@bootkicker.pot, the template of the translations, from three sources:
// - the settings schema: descriptions, tooltips, spinbutton units, combobox labels, list column titles, and the label
//   and tooltip of each button in the "buttons" of a custom row. cinnamon-settings translates the first five through
//   the domain of the uuid (xlet-settings.py:339-359); backup_buttons.py translates the buttons itself. The title of
//   each page and section of the "layout" key is translated by build_with_layout (xlet-settings.py); an empty title
//   is not a text.
// - metadata.json: the name and the description, which cinnamon-settings shows translated in the Manage and Download
//   lists (bin/ExtensionCore.py:173-174), and the name in the title of the settings window (xlet-settings.py:272).
// - the code: every text given to _() in extension.js and in the Python files of the settings window, and both forms of
//   every text given to ngettext (Python) or dngettext (JavaScript), read with xgettext (package gettext).
// A text found twice is written once, where it is first found. The layout is the one this script has always written:
// the same header, then each text with an empty translation, and nothing else (no date, no source line), so the file
// changes only when a text does. It is written only then.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const extDir = path.join(__dirname, '..', 'files', 'window-memory@bootkicker');
const potPath = path.join(extDir, 'po', 'window-memory@bootkicker.pot');

// The code that xgettext reads, by language, with the keywords of each: only these, none of xgettext's defaults.
// extension.js translates with _ (Gettext.dgettext in the domain of the uuid), and a text that depends on a count
// would need Gettext.dngettext(UUID, ...). The Python files use _ and _TRANSLATIONS.ngettext.
const CODE = [
    { language: 'JavaScript', keywords: ['_', 'dngettext:2,3'], files: ['extension.js'] },
    { language: 'Python', keywords: ['_', 'ngettext:1,2'], files: ['forget_button.py', 'backup_buttons.py', 'version_info.py', 'startup_list.py', 'pick_button.py'] },
];

const HEADER = 'msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=UTF-8\\n"\n"Project-Id-Version: window-memory@bootkicker\\n"\n\n';

function schemaTexts(schema) {
    const ids = [];
    for (const def of Object.values(schema)) {
        if (def.type === 'layout') {
            // "pages" is a list of names; every other field but "type" is a page or a section, each with a "title".
            for (const [name, part] of Object.entries(def)) {
                if (name !== 'type' && name !== 'pages' && part.title && part.title.trim()) ids.push(part.title);
            }
            continue;
        }
        if (def.description) ids.push(def.description);
        if (def.tooltip) ids.push(def.tooltip);
        if (def.units) ids.push(def.units);
        if (def.options) ids.push(...Object.keys(def.options));
        if (def.columns) ids.push(...def.columns.map(c => c.title));
        if (def.buttons) {
            for (const button of def.buttons) {
                if (button.label) ids.push(button.label);
                if (button.tooltip) ids.push(button.tooltip);
            }
        }
    }
    return ids.map(msgid => ({ msgid: msgid, plural: null }));
}

function unescape(text) {
    return text.replace(/\\(["\\nt])/g, (m, c) => ({ '"': '"', '\\': '\\', n: '\n', t: '\t' })[c]);
}

function quote(text) {
    return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"';
}

// The entries of the PO text that xgettext writes, without its header: [{msgid, plural}], plural being null for a
// text that is not counted. Comments and flags are left out.
function readPo(text) {
    const entries = [];
    let entry = null;
    let key = null;
    for (const line of text.split('\n')) {
        const start = /^(msgid|msgid_plural|msgstr|msgstr\[\d+\]) "(.*)"$/.exec(line);
        const more = /^"(.*)"$/.exec(line);
        if (start) {
            key = start[1];
            if (key === 'msgid') entries.push(entry = { msgid: '', plural: null });
            if (key === 'msgid' || key === 'msgid_plural') entry[key === 'msgid' ? 'msgid' : 'plural'] = unescape(start[2]);
        } else if (more && key !== null) {
            if (key === 'msgid') entry.msgid += unescape(more[1]);
            else if (key === 'msgid_plural') entry.plural += unescape(more[1]);
        } else if (line.trim() === '' || line.startsWith('#')) {
            key = null;
        } else {
            throw new Error('make-pot: xgettext wrote a line that is not PO: ' + JSON.stringify(line));
        }
    }
    return entries.filter(e => e.msgid !== '');
}

function codeTexts() {
    const entries = [];
    for (const { language, keywords, files } of CODE) {
        let out;
        try {
            out = execFileSync('xgettext', [
                '--language=' + language, '--from-code=UTF-8',
                '--keyword', ...keywords.map(k => '--keyword=' + k),
                '--no-location', '--no-wrap', '--output=-', ...files,
            ], { cwd: extDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
        } catch (e) {
            if (e.code === 'ENOENT') {
                console.error('make-pot: xgettext is not installed; it comes with gettext (sudo apt install gettext)');
                process.exit(1);
            }
            throw e;
        }
        entries.push(...readPo(out));
    }
    return entries;
}

const schema = JSON.parse(fs.readFileSync(path.join(extDir, 'settings-schema.json'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(extDir, 'metadata.json'), 'utf8'));
const found = [
    ...schemaTexts(schema),
    ...[meta.name, meta.description].filter(Boolean).map(msgid => ({ msgid: msgid, plural: null })),
    ...codeTexts(),
];

// msgid -> plural, in the order the texts were found. gettext keeps one entry per msgid, so a text cannot be counted
// in one place and not in another, or have two plurals.
const texts = new Map();
for (const { msgid, plural } of found) {
    if (!texts.has(msgid)) texts.set(msgid, plural);
    else if (texts.get(msgid) !== plural) throw new Error('make-pot: "' + msgid + '" is used with two different plural forms');
}

const body = [...texts].map(([msgid, plural]) => 'msgid ' + quote(msgid) + '\n' + (plural === null
    ? 'msgstr ""\n'
    : 'msgid_plural ' + quote(plural) + '\nmsgstr[0] ""\nmsgstr[1] ""\n')).join('\n');
const text = HEADER + body;

fs.mkdirSync(path.dirname(potPath), { recursive: true });
let old = null;
try {
    old = fs.readFileSync(potPath, 'utf8');
} catch (e) {
    if (e.code !== 'ENOENT') throw e;
}
if (text !== old) fs.writeFileSync(potPath, text);
