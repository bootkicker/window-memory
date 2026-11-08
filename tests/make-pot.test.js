const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const extDir = path.join(__dirname, '..', 'files', 'window-memory@bootkicker');
const poDir = path.join(extDir, 'po');
// The Cinnamon Spices store names the template after the uuid (po/<uuid>.pot) and makes it again with its own tool.
const potPath = path.join(poDir, 'window-memory@bootkicker.pot');
const makePot = path.join(__dirname, '..', 'scripts', 'make-pot.js');

// make-pot.js reads the texts of the code with xgettext, and the translations are compiled with msgfmt. Both come with
// gettext; a test that needs one skips itself without it.
const hasXgettext = !spawnSync('xgettext', ['--version']).error;
const hasMsgfmt = !spawnSync('msgfmt', ['--version']).error;
const NO_XGETTEXT = 'xgettext is not installed (package gettext): make-pot.js cannot read the texts of the code';
const NO_MSGFMT = 'msgfmt is not installed (package gettext): the translations cannot be compiled';

// The header of the template, as make-pot.js writes it.
const HEADER = 'msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=UTF-8\\n"\n"Project-Id-Version: window-memory@bootkicker\\n"\n\n';

// Fields whose string values are user-visible text, and the schema fields known to
// carry none. Any other field name fails the test below, so a new label-like field
// cannot slip past the template. cinnamon-settings translates the descriptions,
// tooltips, units, option labels and column titles through the UUID domain
// (xlet-settings.py:339-359). The "buttons" of a custom row (backup_buttons.py) hold
// a "label" and a "tooltip" for each button, which it passes on as they are. The "align" of a list column is a number.
const LABEL_FIELDS = ['description', 'tooltip', 'units', 'title', 'label'];
const NON_LABEL_FIELDS = ['type', 'default', 'min', 'max', 'step', 'callback', 'id', 'options', 'columns', 'file', 'widget', 'buttons', 'align'];
// The layout key (type "layout") names the tabs of the settings window: "pages" lists them, and each page and each section
// is a field of its own with a "title" that xlet-settings.py translates (build_with_layout); "sections" and "keys" are names.
const LAYOUT_NAME_FIELDS = ['pages', 'sections', 'keys'];

// The files whose texts the template takes from the code, with the comment marker of their language.
const CODE_FILES = { 'extension.js': '//', 'forget_button.py': '#', 'backup_buttons.py': '#', 'version_info.py': '#', 'startup_list.py': '#', 'pick_button.py': '#' };
// The only _() calls that are not given a literal: backup_buttons.py translates the label and the tooltip of each
// button of its schema item, texts that make-pot.js takes from the schema.
const NOT_LITERAL = { 'extension.js': [], 'forget_button.py': [], 'backup_buttons.py': ['label', 'tooltip'], 'version_info.py': [], 'startup_list.py': [], 'pick_button.py': [] };

// The placeholders a text of the code is filled in with: %s (extension.js), and %(name)s and %(name)d (Python).
// %s and %d are accepted too.
const PLACEHOLDER = /%(?:\([A-Za-z_][A-Za-z0-9_]*\))?[sd]/g;

function expectedMsgids(schema) {
    const expected = new Set();
    const unknown = new Set();
    const visit = (node) => {
        if (node.type === 'layout') {
            for (const [field, value] of Object.entries(node)) {
                if (field !== 'type' && !LAYOUT_NAME_FIELDS.includes(field)) visit(value);
            }
            return;
        }
        for (const [field, value] of Object.entries(node)) {
            if (LAYOUT_NAME_FIELDS.includes(field)) continue;
            if (LABEL_FIELDS.includes(field)) {
                if (typeof value === 'string' && value !== '') expected.add(value);
            } else if (field === 'options') {
                Object.keys(value).forEach(label => expected.add(label));
            } else if (field === 'columns' || field === 'buttons') {
                value.forEach(visit);
            } else if (!NON_LABEL_FIELDS.includes(field)) {
                unknown.add(field);
            }
        }
    };
    Object.values(schema).forEach(visit);
    return { expected, unknown };
}

function potMsgids(pot) {
    // readPo unescapes \\n and the others: a text with several paragraphs is in the template on one line with \\n.
    return readPo(pot).map(e => e.msgid);
}

function unescapePo(text) {
    return text.replace(/\\(["\\nt])/g, (m, c) => ({ '"': '"', '\\': '\\', n: '\n', t: '\t' })[c]);
}

function quotePo(text) {
    return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"';
}

// The entries of a PO file, without the header (the entry of msgid ""): {msgid, plural, msgstr}. plural is the
// msgid_plural, or null; msgstr holds the translation, or one translation per plural form (msgstr[n]). Comment lines
// are skipped, as msgfmt skips them; a line that is not PO throws.
function readPo(text) {
    const entries = [];
    let fields = null;
    let key = null;
    for (const line of text.split('\n')) {
        const start = /^(msgid|msgid_plural|msgstr|msgstr\[\d+\]) "(.*)"$/.exec(line);
        const more = /^"(.*)"$/.exec(line);
        if (start) {
            if (start[1] === 'msgid') entries.push(fields = {});
            if (!fields || start[1] in fields) throw new Error('a misplaced ' + start[1] + ': ' + line);
            key = start[1];
            fields[key] = unescapePo(start[2]);
        } else if (more && key !== null) {
            fields[key] += unescapePo(more[1]);
        } else if (line.trim() === '' || line.startsWith('#')) {
            key = null;
        } else {
            throw new Error('not a line of a PO file: ' + JSON.stringify(line));
        }
    }
    return entries.filter(f => f.msgid !== '').map(f => ({
        msgid: f.msgid,
        plural: 'msgid_plural' in f ? f.msgid_plural : null,
        msgstr: 'msgstr' in f ? [f.msgstr] : Object.keys(f).filter(k => k.startsWith('msgstr[')).sort().map(k => f[k]),
    }));
}

// An entry in the layout of the template: the texts, and an empty translation for each form.
function formatEntry(entry, msgstr) {
    msgstr = msgstr || (entry.plural === null ? [''] : ['', '']);
    let out = 'msgid ' + quotePo(entry.msgid) + '\n';
    if (entry.plural === null) return out + 'msgstr ' + quotePo(msgstr[0]) + '\n';
    out += 'msgid_plural ' + quotePo(entry.plural) + '\n';
    return out + msgstr.map((s, i) => 'msgstr[' + i + '] ' + quotePo(s) + '\n').join('');
}

function placeholders(text) {
    return (text.match(PLACEHOLDER) || []).sort();
}

// Runs make-pot.js and returns the template it wrote. It prints nothing: xgettext warns, for one, about a Python text
// with more than one unnamed placeholder, which a translation could not put in another order.
function runMakePot() {
    const r = spawnSync('node', [makePot], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '', 'make-pot.js printed: ' + r.stderr);
    return fs.readFileSync(potPath, 'utf8');
}

// The source of a code file without its whole-line comments, which may name _() and ngettext.
function codeSource(file) {
    const marker = CODE_FILES[file];
    return fs.readFileSync(path.join(extDir, file), 'utf8').split('\n')
        .filter(line => !line.trimStart().startsWith(marker)).join('\n');
}

// A string literal of JavaScript or Python, and one or more in a row, which Python joins into one text.
const LITERAL = String.raw`'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"`;
const LITERALS = String.raw`(?:(?:${LITERAL})\s*)+`;

function literalValue(literals) {
    return [...literals.matchAll(new RegExp(LITERAL, 'g'))]
        .map(m => m[0].slice(1, -1).replace(/\\(.)/g, (s, c) => ({ n: '\n', t: '\t' })[c] || c))
        .join('');
}

// What a code file gives to the translation, read from its source without xgettext: texts, the literal texts given to
// _(); plurals, the two literal forms given to ngettext (Python) or Gettext.dngettext(UUID, ...) (JavaScript); others,
// the source of each _() argument that is not a literal; calls, the number of ngettext and dngettext calls.
function codeTexts(file) {
    const src = codeSource(file);
    const texts = [];
    const others = [];
    for (const m of src.matchAll(/(?<![\w.$]|def )_\(/g)) {
        const rest = src.slice(m.index + m[0].length);
        const literal = new RegExp(String.raw`^\s*(${LITERALS})\)`).exec(rest);
        if (literal) texts.push(literalValue(literal[1]));
        else others.push(rest.slice(0, rest.indexOf(')')).trim());
    }
    const pluralCall = new RegExp(String.raw`(?:\bdngettext\(\s*UUID\s*,|\bngettext\()\s*(${LITERALS}),\s*(${LITERALS}),`, 'g');
    const plurals = [...src.matchAll(pluralCall)].map(m => [literalValue(m[1]), literalValue(m[2])]);
    const calls = (src.match(/\b(?:dngettext|ngettext)\(/g) || []).length;
    return { texts, plurals, others, calls };
}

function allCodeTexts() {
    const texts = [];
    const plurals = [];
    for (const file of Object.keys(CODE_FILES)) {
        const found = codeTexts(file);
        texts.push(...found.texts);
        plurals.push(...found.plurals);
    }
    return { texts, plurals };
}

// Everything that is wrong with the translation file at file against the entries of the template: a text it lacks or
// has in addition, a text given twice, a plural that is not the template's, a translation that does not have the
// placeholders of its text. An empty translation is fine: that text stays in English.
function poProblems(file, template) {
    let entries;
    try {
        entries = readPo(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return ['cannot be read: ' + e.message];
    }
    const problems = [];
    const wanted = new Map(template.map(e => [e.msgid, e]));
    const seen = new Set();
    for (const entry of entries) {
        if (seen.has(entry.msgid)) problems.push('given twice: ' + entry.msgid);
        seen.add(entry.msgid);
        const own = wanted.get(entry.msgid);
        if (!own) {
            problems.push('not in the template: ' + entry.msgid);
            continue;
        }
        if (entry.plural !== own.plural) problems.push('not the plural of the template: ' + entry.msgid);
        const marks = placeholders(entry.plural === null ? entry.msgid : entry.plural);
        entry.msgstr.forEach((text, i) => {
            if (text !== '' && placeholders(text).join(' ') !== marks.join(' ')) {
                problems.push('translation ' + i + ' of "' + entry.msgid + '" has the placeholders [' + placeholders(text).join(' ')
                    + '], not [' + marks.join(' ') + ']');
            }
        });
    }
    for (const msgid of wanted.keys()) if (!seen.has(msgid)) problems.push('missing: ' + msgid);
    return problems;
}

// msgfmt -c, as the Spices installer runs it on each po/<lang>.po (cinnamon-settings bin/Spices.py:733-737): its
// output, or null when it accepts the file.
function msgfmtRefusal(file) {
    const r = spawnSync('msgfmt', ['-c', '-o', '/dev/null', file], { encoding: 'utf8' });
    return r.status === 0 ? null : (r.stderr || 'exit ' + r.status);
}

function translations() {
    return fs.readdirSync(poDir).filter(name => name.endsWith('.po')).sort().map(name => path.join(poDir, name));
}

test('make-pot writes a template with every description and tooltip', (t) => {
    if (!hasXgettext) return t.skip(NO_XGETTEXT);
    const pot = runMakePot();
    assert.match(pot, /msgid "Enable Window Memory"/);
    assert.match(pot, /msgid "Application and window title"/);
    assert.match(pot, /msgid "Remember minimized state"/);
    assert.match(pot, /msgid "Pick a window to never remember \(Click it, Esc or right-click to cancel\)"/);
    assert.match(pot, /msgid "Version"\nmsgstr ""/);
    assert.doesNotMatch(pot, /never remember \(click the window\)/);
    assert.match(pot, /msgid "Click here, then click the window you want to add to the never-remember list\. Escape or a right-click cancels\."/);
    // The spin button that pick_button.py puts in the toolbar of the never-remember list.
    assert.match(pot, /msgid "Max windows"/);
    assert.doesNotMatch(pot, /msgid "Click the window you want to add/);
    // The note of the Version row on Wayland (version_info.py).
    assert.match(pot, /msgid "Wayland \(experimental\)"/);
    assert.match(pot, /msgid "You are using Cinnamon's Wayland session, which is still experimental\./);

    const schema = JSON.parse(fs.readFileSync(path.join(extDir, 'settings-schema.json'), 'utf8'));
    const { expected, unknown } = expectedMsgids(schema);
    assert.deepEqual([...unknown], [], 'schema uses fields the pot test does not classify');

    const ids = potMsgids(pot);
    assert.equal(new Set(ids).size, ids.length, 'duplicate msgids in the template');
    for (const label of expected) {
        assert.ok(ids.includes(label), 'missing from pot: ' + label);
    }
});

test('make-pot writes the title of each tab of the settings window and the heading of the sections once, and none for an empty section title', (t) => {
    if (!hasXgettext) return t.skip(NO_XGETTEXT);
    const ids = potMsgids(runMakePot());
    for (const text of ['General', 'Startup apps', 'Settings for window-memory@bootkicker']) assert.ok(ids.includes(text), 'missing from pot: ' + text);
    // Both sections have the same title: one text, once (the duplicate check above is on the whole template).
    assert.equal(ids.filter(id => id === 'Settings for window-memory@bootkicker').length, 1);
    assert.ok(!ids.includes(''));
});

test('make-pot writes the label and the tooltip of each button of the backup row', (t) => {
    if (!hasXgettext) return t.skip(NO_XGETTEXT);
    const ids = potMsgids(runMakePot());
    for (const text of [
        'Back up or restore settings and remembered windows',
        'Export backup…',
        'Save every setting, the never-remember list and the remembered windows to a file.',
        'Import backup…',
        'Replace every setting and remembered window with the ones in a backup file. Asks first.',
    ]) assert.ok(ids.includes(text), 'missing from pot: ' + text);
});

// cinnamon-settings shows the name and the description of metadata.json translated in the Manage and Download lists
// (bin/ExtensionCore.py:173-174), and the name in the title of the settings window (xlet-settings.py:272).
test('make-pot writes the name and the description of metadata.json', (t) => {
    if (!hasXgettext) return t.skip(NO_XGETTEXT);
    const ids = potMsgids(runMakePot());
    const meta = JSON.parse(fs.readFileSync(path.join(extDir, 'metadata.json'), 'utf8'));
    assert.ok(ids.includes(meta.name), 'missing from pot: ' + meta.name);
    assert.ok(ids.includes(meta.description), 'missing from pot: ' + meta.description);
});

test('every _() in the code is given its text as a literal, which xgettext can read, except the schema texts of the backup row', () => {
    for (const file of Object.keys(CODE_FILES)) {
        const found = codeTexts(file);
        assert.ok(found.texts.length > 0, file + ' gives no text to _()');
        assert.deepEqual(found.others.sort(), NOT_LITERAL[file].slice().sort(), file + ': _() of something that is not a literal');
        assert.equal(found.plurals.length, found.calls, file + ': an ngettext or dngettext whose two forms are not literals');
    }
    // The plurals: the Python files count windows and settings; the notifications of extension.js count nothing.
    assert.ok(codeTexts('forget_button.py').plurals.length > 0 && codeTexts('backup_buttons.py').plurals.length > 0);
});

test('make-pot writes every text of the code, with the plural form of each counted text, and every text once', (t) => {
    if (!hasXgettext) return t.skip(NO_XGETTEXT);
    const entries = readPo(runMakePot());
    const schema = JSON.parse(fs.readFileSync(path.join(extDir, 'settings-schema.json'), 'utf8'));
    const meta = JSON.parse(fs.readFileSync(path.join(extDir, 'metadata.json'), 'utf8'));
    const code = allCodeTexts();
    const expected = new Set([...expectedMsgids(schema).expected, meta.name, meta.description, ...code.texts, ...code.plurals.map(p => p[0])]);
    const ids = entries.map(e => e.msgid);
    assert.equal(new Set(ids).size, ids.length, 'duplicate msgids in the template');
    assert.deepEqual(ids.filter(id => !expected.has(id)), [], 'in the template, but in no source');
    assert.deepEqual([...expected].filter(id => !ids.includes(id)), [], 'missing from the template');
    const plurals = new Map(code.plurals);
    for (const entry of entries) {
        assert.equal(entry.plural, plurals.has(entry.msgid) ? plurals.get(entry.msgid) : null, 'the plural of ' + entry.msgid);
    }
    // A few texts of the code, spelled out.
    for (const text of ['Window Memory', 'Forgot the remembered window of %s.', 'Forgot all remembered windows.', 'Report an issue',
        '(uncommitted changes)', '_Replace', 'JSON files', 'The current settings and remembered windows are lost. This cannot be undone.']) {
        assert.ok(ids.includes(text), 'missing from pot: ' + text);
    }
    assert.equal(plurals.get('%(count)d remembered window was forgotten.'), '%(count)d remembered windows were forgotten.');
});

// "x, _ = f()" or "for _ in ..." in a Python function makes _ a local name there, which hides the translation
// function for the whole function. So _ is used only as the function: a call, or the one definition.
test('no code file uses _ as a name of its own, which would hide the translation function', () => {
    for (const file of Object.keys(CODE_FILES)) {
        const src = codeSource(file)
            .replace(new RegExp(LITERAL, 'g'), "''")
            .replace(/^const _ = \(s\) => /m, '');
        const bare = (src.match(/(?<![\w.$])_(?![\w($])/g) || []).length;
        assert.equal(bare, 0, file + ' uses _ as a name');
    }
});

// The placeholder check of the translations (below) can only keep the placeholders it knows.
test('every placeholder in a text of the code is one the translation check knows, and both forms of a counted text have the same', () => {
    const code = allCodeTexts();
    for (const text of [...code.texts, ...code.plurals.flat()]) {
        assert.ok(!text.replace(PLACEHOLDER, '').includes('%'), 'a % that is not a known placeholder: ' + text);
    }
    for (const [one, many] of code.plurals) assert.deepEqual(placeholders(one), placeholders(many), one);
});

// The layout of the template: the header, then each text with an empty translation, and nothing
// else: no comment, no flag, no date, no source line. scripts/check.sh fails when a new run changes the file.
test('the template keeps its layout, and make-pot writes the same file again', (t) => {
    if (!hasXgettext) return t.skip(NO_XGETTEXT);
    const pot = runMakePot();
    assert.ok(pot.startsWith(HEADER), 'the header is the one it was');
    assert.equal(pot, HEADER + readPo(pot).map(entry => formatEntry(entry)).join('\n'));
    assert.equal(runMakePot(), pot);
});

test('the template is a PO file that msgfmt -c accepts', (t) => {
    if (!hasXgettext) return t.skip(NO_XGETTEXT);
    if (!hasMsgfmt) return t.skip(NO_MSGFMT);
    runMakePot();
    assert.equal(msgfmtRefusal(potPath), null);
});

test('every translation in po/ has exactly the texts of the template, and each translation keeps the placeholders of its text', (t) => {
    if (!hasXgettext) return t.skip(NO_XGETTEXT);
    const template = readPo(runMakePot());
    const files = translations();
    if (files.length === 0) t.diagnostic('po/ holds no translation yet');
    for (const file of files) assert.deepEqual(poProblems(file, template), [], path.basename(file));
});

test('every translation in po/ compiles with msgfmt -c', (t) => {
    if (!hasMsgfmt) return t.skip(NO_MSGFMT);
    const files = translations();
    if (files.length === 0) t.diagnostic('po/ holds no translation yet');
    for (const file of files) assert.equal(msgfmtRefusal(file), null, path.basename(file));
});

// The two checks above, on made-up translations of the real template in a temp folder: a complete one passes, and each
// fault is found.
test('the translation checks find a missing text, an extra one, a lost or renamed placeholder, and a file msgfmt refuses', (t) => {
    if (!hasXgettext) return t.skip(NO_XGETTEXT);
    const template = readPo(runMakePot());
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'make-pot-'));
    try {
        const header = 'msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=UTF-8\\n"\n"Plural-Forms: nplurals=2; plural=(n > 1);\\n"\n\n';
        // Every text "translated" as itself between brackets, which keeps its placeholders; the first left untranslated.
        const translated = template.map((entry, i) => ({
            entry: entry,
            msgstr: i === 0 ? null : (entry.plural === null ? ['[' + entry.msgid + ']'] : ['[' + entry.msgid + ']', '[' + entry.plural + ']']),
        }));
        const write = (name, items, head) => {
            const file = path.join(tmp, name);
            fs.writeFileSync(file, (head || header) + items.map(item => formatEntry(item.entry, item.msgstr)).join('\n'));
            return file;
        };
        const withPlaceholder = translated.findIndex(item => item.entry.plural === null && placeholders(item.entry.msgid).length > 0);
        const counted = translated.findIndex(item => item.entry.plural !== null && placeholders(item.entry.plural).length > 0);
        assert.ok(withPlaceholder > 0 && counted > 0, 'the template has a text with a placeholder, and a counted one');
        const changed = (index, msgstr) => translated.map((item, i) => (i === index ? { entry: item.entry, msgstr: msgstr } : item));

        const good = write('good.po', translated);
        assert.deepEqual(poProblems(good, template), []);
        const lost = write('lost.po', changed(withPlaceholder, [translated[withPlaceholder].msgstr[0].replace(PLACEHOLDER, '')]));
        assert.equal(poProblems(lost, template).length, 1);
        assert.match(poProblems(lost, template)[0], /^translation 0 of .* has the placeholders \[\], not \[%/);
        const renamed = write('renamed.po', changed(counted, [translated[counted].msgstr[0], translated[counted].msgstr[1].replace('%(count)d', '%(nombre)d')]));
        assert.match(poProblems(renamed, template).join('\n'), /^translation 1 of .* has the placeholders \[%\(nombre\)d\]/);
        const missing = write('missing.po', translated.slice(0, -1));
        assert.deepEqual(poProblems(missing, template), ['missing: ' + template[template.length - 1].msgid]);
        const extra = write('extra.po', translated.concat([{ entry: { msgid: 'A text the code does not have', plural: null }, msgstr: ['x'] }]));
        assert.deepEqual(poProblems(extra, template), ['not in the template: A text the code does not have']);
        const twice = write('twice.po', translated.concat([translated[1]]));
        assert.deepEqual(poProblems(twice, template), ['given twice: ' + template[1].msgid]);

        if (!hasMsgfmt) return t.skip(NO_MSGFMT);
        assert.equal(msgfmtRefusal(good), null);
        // Counted texts need the language's plural forms in the header, or msgfmt -c (and so the Spices installer) refuses the file.
        const noPluralForms = write('no-plural-forms.po', translated, 'msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=UTF-8\\n"\n\n');
        assert.match(msgfmtRefusal(noPluralForms) || '', /Plural-Forms|plural=EXPRESSION|nplurals=INTEGER/);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

const hasXletMakepot = !spawnSync('cinnamon-xlet-makepot', ['--help']).error;

function msgidsOf(text) {
    return new Set([...text.matchAll(/^msgid ((?:"(?:[^"\\]|\\.)*"\n?)+)/gm)]
        .map(m => [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(x => x[1]).join(''))
        .filter(id => id !== ''));
}

test('the template tool of Cinnamon and the Spices store finds the same texts as make-pot.js, so that a template they make keeps every translation', (t) => {
    if (!hasXletMakepot) return t.skip('cinnamon-xlet-makepot is not installed');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-xlet-'));
    try {
        const uuid = 'window-memory@bootkicker';
        const folder = path.join(tmp, uuid);
        fs.mkdirSync(path.join(folder, 'files'), { recursive: true });
        fs.cpSync(extDir, path.join(folder, 'files', uuid), { recursive: true });
        const out = path.join(tmp, 'theirs.pot');
        const r = spawnSync('cinnamon-xlet-makepot', ['-o', out, folder], { encoding: 'utf8', cwd: folder });
        assert.equal(r.status, 0, r.stderr);
        const theirs = msgidsOf(fs.readFileSync(out, 'utf8'));
        const ours = msgidsOf(fs.readFileSync(potPath, 'utf8'));
        assert.deepEqual([...ours].filter(id => !theirs.has(id)), [], 'texts of ours that their tool does not find');
        assert.deepEqual([...theirs].filter(id => !ours.has(id)), [], 'texts of theirs that make-pot.js does not find');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('no translation file says that it is a draft', () => {
    for (const file of fs.readdirSync(poDir).filter(f => f.endsWith('.po'))) {
        assert.doesNotMatch(fs.readFileSync(path.join(poDir, file), 'utf8'), /draft/i, file);
    }
});
