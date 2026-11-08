// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Pick = require(path.join(__dirname, '..', 'files', 'window-memory@bootkicker', 'lib', 'pick.js'));

function win(over) {
    return Object.assign({
        rect: { x: 0, y: 0, w: 100, h: 100 }, wmClass: 'Firefox', type: 'normal', role: '', stack: 0,
    }, over || {});
}

test('normalizeClass trims and lowercases, and treats a missing name as empty', () => {
    assert.equal(Pick.normalizeClass('  Firefox '), 'firefox');
    assert.equal(Pick.normalizeClass('Gnome-Terminal'), 'gnome-terminal');
    assert.equal(Pick.normalizeClass(''), '');
    assert.equal(Pick.normalizeClass(null), '');
    assert.equal(Pick.normalizeClass(undefined), '');
});

test('addToList appends the class to a new list and leaves the input list alone', () => {
    const list = ['xed'];
    const out = Pick.addToList(list, 'Firefox');
    assert.deepEqual(out, ['xed', 'Firefox']);
    assert.notEqual(out, list);
    assert.deepEqual(list, ['xed']);
});

test('addToList does not add a class twice, whatever its case or padding', () => {
    assert.deepEqual(Pick.addToList(['firefox'], 'Firefox'), ['firefox']);
    assert.deepEqual(Pick.addToList(['Firefox'], '  FIREFOX '), ['Firefox']);
});

test('addToList keeps every existing row exactly as it is: blank rows, repeats, case and padding', () => {
    const list = ['', 'xed', '   ', 'Xed', ' Brave-Browser ', 'xed'];
    assert.deepEqual(Pick.addToList(list, 'Firefox'), ['', 'xed', '   ', 'Xed', ' Brave-Browser ', 'xed', 'Firefox']);
    assert.deepEqual(Pick.addToList(list, 'xed'), list);
    assert.deepEqual(list, ['', 'xed', '   ', 'Xed', ' Brave-Browser ', 'xed']);
});

test('addToList adds nothing for an empty class', () => {
    assert.deepEqual(Pick.addToList(['xed'], ''), ['xed']);
    assert.deepEqual(Pick.addToList(['xed'], '   '), ['xed']);
    assert.deepEqual(Pick.addToList(['xed'], null), ['xed']);
    assert.deepEqual(Pick.addToList(['xed'], undefined), ['xed']);
});

test('addToList does not append a class that a row already covers: a row that is part of the class', () => {
    assert.deepEqual(Pick.addToList(['fire'], 'Firefox'), ['fire']);
    assert.deepEqual(Pick.addToList(['xed', 'FOX'], 'Firefox'), ['xed', 'FOX']);
    assert.deepEqual(Pick.addToList([' fire '], 'Firefox'), [' fire ']);
});

test('addToList appends a class that no row covers: a longer row, a blank row or an unrelated row', () => {
    assert.deepEqual(Pick.addToList(['firefox-esr'], 'Firefox'), ['firefox-esr', 'Firefox']);
    assert.deepEqual(Pick.addToList([''], 'Firefox'), ['', 'Firefox']);
    assert.deepEqual(Pick.addToList(['   '], 'Firefox'), ['   ', 'Firefox']);
    assert.deepEqual(Pick.addToList(['xed'], 'Firefox'), ['xed', 'Firefox']);
});

test('addToList appends a new class once, however often it is added', () => {
    const once = Pick.addToList(['xed'], 'Firefox');
    const twice = Pick.addToList(once, 'Firefox');
    const again = Pick.addToList(twice, 'firefox');
    assert.deepEqual(again, ['xed', 'Firefox']);
});

test('addToList stores the new class trimmed, in its own case, and accepts a missing list', () => {
    assert.deepEqual(Pick.addToList([], '  Brave-browser '), ['Brave-browser']);
    assert.deepEqual(Pick.addToList(null, 'Brave-browser'), ['Brave-browser']);
    assert.deepEqual(Pick.addToList(undefined, 'Brave-browser'), ['Brave-browser']);
});

test('isCovered follows the exclusion rule: some row, ignoring case, is part of the class', () => {
    assert.equal(Pick.isCovered(['Firefox'], ' firefox '), true);
    assert.equal(Pick.isCovered(['fire'], 'Firefox'), true);
    assert.equal(Pick.isCovered(['FOX'], 'Firefox'), true);
    assert.equal(Pick.isCovered(['firefox-esr'], 'Firefox'), false);
    assert.equal(Pick.isCovered(['xed'], 'Firefox'), false);
    assert.equal(Pick.isCovered(['', '  ', null, undefined], 'Firefox'), false);
    assert.equal(Pick.isCovered([], 'Firefox'), false);
    assert.equal(Pick.isCovered(null, 'Firefox'), false);
    assert.equal(Pick.isCovered(['xed'], ''), false);
});

test('topWindowAt returns the candidate that contains the point', () => {
    const a = win({ wmClass: 'A', rect: { x: 0, y: 0, w: 100, h: 100 } });
    const b = win({ wmClass: 'B', rect: { x: 200, y: 0, w: 100, h: 100 } });
    assert.equal(Pick.topWindowAt([a, b], 50, 50), a);
    assert.equal(Pick.topWindowAt([a, b], 250, 50), b);
});

test('topWindowAt returns null when no window contains the point, or there are no windows', () => {
    const a = win({ rect: { x: 0, y: 0, w: 100, h: 100 } });
    assert.equal(Pick.topWindowAt([a], 500, 500), null);
    assert.equal(Pick.topWindowAt([], 5, 5), null);
    assert.equal(Pick.topWindowAt(null, 5, 5), null);
    assert.equal(Pick.topWindowAt(undefined, 5, 5), null);
});

test('topWindowAt includes the left and top edges and excludes the right and bottom edges', () => {
    const a = win({ rect: { x: 10, y: 20, w: 100, h: 50 } });
    assert.equal(Pick.topWindowAt([a], 10, 20), a);
    assert.equal(Pick.topWindowAt([a], 109, 69), a);
    assert.equal(Pick.topWindowAt([a], 110, 40), null);
    assert.equal(Pick.topWindowAt([a], 50, 70), null);
    assert.equal(Pick.topWindowAt([a], 9, 40), null);
    assert.equal(Pick.topWindowAt([a], 50, 19), null);
});

test('topWindowAt takes the highest stack among overlapping windows, not the last in the array', () => {
    const low = win({ wmClass: 'Low', stack: 1 });
    const high = win({ wmClass: 'High', stack: 5 });
    const mid = win({ wmClass: 'Mid', stack: 3 });
    assert.equal(Pick.topWindowAt([high, low, mid], 50, 50), high);
    assert.equal(Pick.topWindowAt([low, mid, high], 50, 50), high);
});

test('topWindowAt ignores a higher window that does not contain the point', () => {
    const under = win({ wmClass: 'Under', stack: 1, rect: { x: 0, y: 0, w: 100, h: 100 } });
    const over = win({ wmClass: 'Over', stack: 9, rect: { x: 60, y: 60, w: 100, h: 100 } });
    assert.equal(Pick.topWindowAt([under, over], 10, 10), under);
    assert.equal(Pick.topWindowAt([under, over], 70, 70), over);
});

test('topWindowAt returns null when the topmost window at the point is a desktop, dock, dialog or other type', () => {
    for (const type of ['desktop', 'dock', 'dialog', 'other']) {
        const above = win({ wmClass: 'Above', type: type, stack: 2 });
        assert.equal(Pick.topWindowAt([above], 50, 50), null, type);
    }
});

test('topWindowAt returns null when the topmost window at the point has no WM_CLASS', () => {
    for (const empty of ['', '   ', null, undefined]) {
        const above = win({ wmClass: empty, stack: 2 });
        assert.equal(Pick.topWindowAt([above], 50, 50), null);
    }
});

test('topWindowAt returns null when the topmost window at the point is a pop-up, like the rest of the extension', () => {
    const popup = win({ wmClass: 'Brave-browser', role: 'pop-up', stack: 2 });
    assert.equal(Pick.topWindowAt([popup], 50, 50), null);
});

test('a window that cannot be picked and covers a terminal gives null, not the terminal', () => {
    const terminal = win({ wmClass: 'Gnome-terminal', stack: 1, rect: { x: 0, y: 0, w: 800, h: 600 } });
    const covers = [
        { name: 'file dialog', over: { wmClass: 'Gnome-terminal', type: 'dialog' } },
        { name: 'pop-up', over: { wmClass: 'Gnome-terminal', role: 'pop-up' } },
        { name: 'dock', over: { wmClass: 'Plank', type: 'dock' } },
        { name: 'menu', over: { wmClass: '', type: 'other' } },
        { name: 'window with no class', over: { wmClass: '' } },
    ];
    for (const c of covers) {
        const above = win(Object.assign({ stack: 2, rect: { x: 100, y: 100, w: 200, h: 200 } }, c.over));
        assert.equal(Pick.topWindowAt([terminal, above], 150, 150), null, c.name); // under the cover: nothing is picked
        assert.equal(Pick.topWindowAt([above, terminal], 150, 150), null, c.name); // whatever the array order
        assert.equal(Pick.topWindowAt([terminal, above], 50, 50), terminal, c.name); // beside the cover: the terminal
    }
});

test('a pickable window above an unpickable one is picked, and the unpickable one below is not', () => {
    const desktop = win({ wmClass: 'Nemo', type: 'desktop', stack: 0, rect: { x: 0, y: 0, w: 1000, h: 800 } });
    const normal = win({ wmClass: 'Gnome-terminal', stack: 1, rect: { x: 100, y: 100, w: 200, h: 200 } });
    assert.equal(Pick.topWindowAt([desktop, normal], 150, 150), normal);
    assert.equal(Pick.topWindowAt([desktop, normal], 500, 500), null); // the bare desktop
});

test('topWindowAt accepts a candidate with no role', () => {
    const c = win({ wmClass: 'Xed' });
    delete c.role;
    assert.equal(Pick.topWindowAt([c], 50, 50), c);
});

test('topWindowAt gives the first of two windows with the same stack, and skips empty rects', () => {
    const first = win({ wmClass: 'First', stack: 4 });
    const second = win({ wmClass: 'Second', stack: 4 });
    assert.equal(Pick.topWindowAt([first, second], 50, 50), first);
    const flat = win({ wmClass: 'Flat', stack: 9, rect: { x: 0, y: 0, w: 0, h: 100 } });
    assert.equal(Pick.topWindowAt([first, flat], 0, 50), first);
});

test('topWindowAt does not choke on a missing candidate or a missing rect', () => {
    const good = win({ wmClass: 'Good', stack: 1 });
    const noRect = win({ wmClass: 'NoRect', stack: 9 });
    delete noRect.rect;
    assert.equal(Pick.topWindowAt([null, noRect, good], 50, 50), good);
});

// excludeRows works on the rows of the excluded-apps list, [{enabled?, wmclass}]: a row with no `enabled` (saved before
// the column existed) counts as enabled.
test('excludeRows: an enabled row that covers the class leaves the rows unchanged, the same array', () => {
    const rows = [{ enabled: true, wmclass: 'xed' }, { enabled: true, wmclass: 'fire' }];
    const out = Pick.excludeRows(rows, 'Firefox');
    assert.equal(out.changed, false);
    assert.equal(out.rows, rows);
});

test('excludeRows: a row without enabled counts as enabled and covers the class', () => {
    const rows = [{ wmclass: ' FIREFOX ' }];
    const out = Pick.excludeRows(rows, 'Firefox');
    assert.equal(out.changed, false);
    assert.equal(out.rows, rows);
});

test('excludeRows: a disabled row with the same class is checked again, every other row stays the same object', () => {
    const a = { enabled: true, wmclass: 'xed' };
    const off = { enabled: false, wmclass: ' firefox ', note: 1 };
    const c = { wmclass: 'gimp' };
    const rows = [a, off, c];
    const out = Pick.excludeRows(rows, 'Firefox');
    assert.equal(out.changed, true);
    assert.deepEqual(out.rows, [a, { enabled: true, wmclass: ' firefox ', note: 1 }, c]);
    assert.equal(out.rows[0], a);
    assert.equal(out.rows[2], c);
    assert.notEqual(out.rows, rows);
    assert.equal(off.enabled, false, 'the stored row is not changed in place');
});

test('excludeRows: a disabled row that only partly matches does not cover the class: a new row is appended', () => {
    const off = { enabled: false, wmclass: 'fire' };
    const rows = [off];
    const out = Pick.excludeRows(rows, ' Firefox ');
    assert.equal(out.changed, true);
    assert.deepEqual(out.rows, [off, { enabled: true, wmclass: 'Firefox' }]);
    assert.equal(out.rows[0], off);
    assert.deepEqual(rows, [{ enabled: false, wmclass: 'fire' }]);
});

test('excludeRows: no row for the class appends {enabled: true, wmclass} with the class trimmed', () => {
    const rows = [{ wmclass: '' }, null, { enabled: true, wmclass: 'xed' }];
    const out = Pick.excludeRows(rows, '  Gnome-terminal ');
    assert.equal(out.changed, true);
    assert.deepEqual(out.rows, [{ wmclass: '' }, null, { enabled: true, wmclass: 'xed' }, { enabled: true, wmclass: 'Gnome-terminal' }]);
    assert.deepEqual(Pick.excludeRows(undefined, 'Xed'), { rows: [{ enabled: true, wmclass: 'Xed' }], changed: true });
});

test('excludeRows: an empty class changes nothing', () => {
    const rows = [{ enabled: false, wmclass: '' }];
    for (const cls of ['', '   ', null, undefined]) {
        const out = Pick.excludeRows(rows, cls);
        assert.equal(out.changed, false);
        assert.equal(out.rows, rows);
    }
});
