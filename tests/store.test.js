const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../files/window-memory@bootkicker/lib/store.js');

const entry = (id, key, lastSeen) => ({
    id: id, key: key, lastSeen: lastSeen, title: '', workspace: 0, maximized: false, monitor: null, rel: null,
});

test('parseState accepts valid input and drops malformed entries', () => {
    const text = JSON.stringify({ version: 1, windows: [entry('a', 'k', 1), { key: 'no-id', lastSeen: 1 }] });
    const r = S.parseState(text);
    assert.equal(r.recovered, false);
    assert.deepEqual(r.state.windows.map(e => e.id), ['a']);
});

test('parseState normalizes the key of an entry saved by the old version to wmClass|instance', () => {
    const text = JSON.stringify({
        version: 1,
        windows: [
            entry('xed', 'xed|xed|xed-window-1-2-0-h', 2),
            entry('ff', 'firefox|navigator|', 1),
            entry('new', 'gedit|gedit', 3),
        ],
    });
    const r = S.parseState(text);
    assert.equal(r.recovered, false);
    assert.deepEqual(r.state.windows.map(e => [e.id, e.key]), [
        ['xed', 'xed|xed'], ['ff', 'firefox|navigator'], ['new', 'gedit|gedit'],
    ]);
});

test('parseState rebuilds the key from the stored class and instance, so a bar inside either one is kept', () => {
    const named = (id, key, wmClass, instance) => Object.assign(entry(id, key, 1), { wmClass: wmClass, instance: instance });
    const text = JSON.stringify({
        version: 1,
        windows: [
            named('bar-class', 'foo|bar|baz', 'Foo|Bar', 'Baz'),
            named('bar-instance', 'foo|bar|baz', 'Foo', 'Bar|Baz'),
            named('old-role', 'xed|xed|xed-window-1-2-0-h', 'Xed', 'xed'),
            named('no-instance', 'firefox|', 'Firefox', ''),
        ],
    });
    const keys = S.parseState(text).state.windows.map(e => [e.id, e.key]);
    assert.deepEqual(keys, [
        ['bar-class', 'foo|bar|baz'], ['bar-instance', 'foo|bar|baz'], ['old-role', 'xed|xed'], ['no-instance', 'firefox|'],
    ]);
});

test('parseState splits the key only when the entry has no stored class or instance', () => {
    const text = JSON.stringify({
        version: 1,
        windows: [
            Object.assign(entry('no-fields', 'a|b|c', 1)),
            Object.assign(entry('blank-class', 'a|b|c', 1), { wmClass: '  ', instance: 'b' }),
            Object.assign(entry('no-instance-field', 'a|b|c', 1), { wmClass: 'A' }),
        ],
    });
    assert.deepEqual(S.parseState(text).state.windows.map(e => e.key), ['a|b', 'a|b', 'a|b']);
});

test('parseState returns a key of two parts or fewer unchanged, without rebuilding it from the stored fields', () => {
    const named = (id, key) => Object.assign(entry(id, key, 1), { wmClass: 'Other', instance: 'Thing' });
    const text = JSON.stringify({
        version: 1,
        windows: [named('two', 'firefox|navigator'), named('no-instance', 'firefox|'), named('one', 'firefox'), named('empty', '')],
    });
    assert.deepEqual(S.parseState(text).state.windows.map(e => e.key), ['firefox|navigator', 'firefox|', 'firefox', '']);
});

test('parseState rebuilds a key of three parts or more, so an old empty-role key loses its trailing bar', () => {
    const named = (id, key, wmClass, instance) => Object.assign(entry(id, key, 1), { wmClass: wmClass, instance: instance });
    const text = JSON.stringify({
        version: 1,
        windows: [
            named('old-empty-role', 'firefox|navigator|', 'Firefox', 'Navigator'),
            named('bar-class-no-instance', 'foo|bar|', 'Foo|Bar', ''),
            named('stale', 'x|y|z', 'Foo', 'Bar'),
        ],
    });
    assert.deepEqual(S.parseState(text).state.windows.map(e => e.key), ['firefox|navigator', 'foo|bar|', 'foo|bar']);
});

test('a class that contains a bar survives a save and a reload with the same key', () => {
    const named = (id, key, wmClass, instance) => Object.assign(entry(id, key, 1), { wmClass: wmClass, instance: instance });
    const state = { version: 1, windows: [named('a', 'foo|bar|baz', 'Foo|Bar', 'Baz'), named('b', 'foo|bar|', 'Foo|Bar', '')] };
    const again = S.parseState(S.serializeState(state)).state;
    assert.deepEqual(again.windows.map(e => e.key), ['foo|bar|baz', 'foo|bar|']);
    assert.deepEqual(S.entriesForKey(again, 'foo|bar|baz').map(e => e.id), ['a']);
});

test('parseState drops entries saved earlier for a pop-up and keeps the others', () => {
    const withRole = (id, role) => Object.assign(entry(id, 'brave-browser|brave-browser', 1), { role: role });
    const text = JSON.stringify({
        version: 1,
        windows: [withRole('pop', 'pop-up'), withRole('main', 'browser'), entry('no-role', 'brave-browser|brave-browser', 1)],
    });
    const r = S.parseState(text);
    assert.equal(r.recovered, false);
    assert.deepEqual(r.state.windows.map(e => e.id), ['main', 'no-role']);
});

test('parseState drops entries whose geometry or flag fields are malformed', () => {
    const goodFull = Object.assign(entry('full', 'k', 2), {
        workspace: 3,
        monitor: { index: 0, x: 0, y: 0, w: 1920, h: 1080 },
        rel: { x: 10, y: 20, w: 800, h: 600 },
    });
    const bad = [
        Object.assign(entry('rel-empty', 'k', 1), { rel: {} }),
        Object.assign(entry('rel-nan', 'k', 1), { rel: { x: 1, y: 2, w: 'x', h: 4 } }),
        Object.assign(entry('rel-str', 'k', 1), { rel: 'oops' }),
        Object.assign(entry('mon-partial', 'k', 1), { monitor: { index: 0, x: 0, y: 0, w: 1920 } }),
        Object.assign(entry('mon-str', 'k', 1), { monitor: 'primary' }),
        Object.assign(entry('max-str', 'k', 1), { maximized: 'false' }),
        Object.assign(entry('ws-str', 'k', 1), { workspace: '2' }),
    ];
    // entry() has rel: null and monitor: null, which must be kept.
    const text = JSON.stringify({ version: 1, windows: [entry('nulls', 'k', 1), goodFull].concat(bad) });
    const r = S.parseState(text);
    assert.equal(r.recovered, false);
    assert.deepEqual(r.state.windows.map(e => e.id), ['nulls', 'full']);
    // A null workspace is valid too.
    const nullWs = JSON.stringify({ version: 1, windows: [Object.assign(entry('nw', 'k', 1), { workspace: null })] });
    assert.deepEqual(S.parseState(nullWs).state.windows.map(e => e.id), ['nw']);
});

test('parseState keeps an entry saved before the minimized field existed', () => {
    const old = entry('old', 'k', 1);
    assert.equal('minimized' in old, false, 'the fixture has no minimized field');
    const r = S.parseState(JSON.stringify({ version: 1, windows: [old] }));
    assert.equal(r.recovered, false);
    assert.equal(r.state.version, 1);
    assert.deepEqual(r.state.windows.map(e => e.id), ['old']);
    assert.equal(r.state.windows[0].minimized, false);
});

test('parseState drops an entry whose minimized is not a boolean', () => {
    const withMinimized = (id, value) => Object.assign(entry(id, 'k', 1), { minimized: value });
    const text = JSON.stringify({
        version: 1,
        windows: [
            entry('absent', 'k', 1),
            withMinimized('yes', true),
            withMinimized('no', false),
            withMinimized('str-true', 'true'),
            withMinimized('str-false', 'false'),
            withMinimized('one', 1),
            withMinimized('zero', 0),
            withMinimized('null', null),
        ],
    });
    const r = S.parseState(text);
    assert.equal(r.recovered, false);
    assert.deepEqual(r.state.windows.map(e => e.id), ['absent', 'yes', 'no']);
});

test('parseState and serializeState keep minimized true', () => {
    const on = Object.assign(entry('on', 'k', 2), { minimized: true });
    const off = Object.assign(entry('off', 'k', 1), { minimized: false });
    const state = { version: 1, windows: [on, off] };
    const again = S.parseState(S.serializeState(state));
    assert.equal(again.recovered, false);
    assert.deepEqual(again.state, state);
});

test('parseState recovers from empty, invalid or wrong-version input', () => {
    for (const text of ['', '{not json', JSON.stringify({ version: 2, windows: [] }), '[]']) {
        const r = S.parseState(text);
        assert.equal(r.recovered, true, text);
        assert.deepEqual(r.state, S.emptyState());
    }
});

test('loadState returns an empty, unrecovered state when the file is missing', () => {
    const io = { read: () => null, write() {}, rename() {} };
    assert.deepEqual(S.loadState(io, '/x/state.json', 5), { state: S.emptyState(), recovered: false });
});

test('loadState moves a corrupt file aside and keeps going', () => {
    const renames = [];
    const io = { read: () => '{oops', write() {}, rename: (a, b) => renames.push([a, b]) };
    const r = S.loadState(io, '/x/state.json', 42);
    assert.equal(r.recovered, true);
    assert.deepEqual(renames, [['/x/state.json', '/x/state.json.bad-42']]);
});

test('loadState still starts fresh when the backup rename fails', () => {
    const io = { read: () => 'bad', write() {}, rename() { throw new Error('EACCES'); } };
    assert.equal(S.loadState(io, '/x/state.json', 1).recovered, true);
});

test('loadState does not move a version-1 file aside when entries carry minimized', () => {
    const renames = [];
    const on = Object.assign(entry('a', 'k', 2), { minimized: true });
    const off = Object.assign(entry('b', 'k', 1), { minimized: false });
    const text = JSON.stringify({ version: 1, windows: [on, off] });
    const io = { read: () => text, write() {}, rename: (a, b) => renames.push([a, b]) };
    const r = S.loadState(io, '/x/state.json', 42);
    assert.equal(r.recovered, false);
    assert.deepEqual(renames, []);
    assert.deepEqual(r.state.windows.map(e => [e.id, e.minimized]), [['a', true], ['b', false]]);
});

test('saveState writes a temp file and renames it over the target', () => {
    const calls = [];
    const io = {
        read() {},
        write: (p, t) => calls.push(['write', p, t.length > 0]),
        rename: (a, b) => calls.push(['rename', a, b]),
    };
    S.saveState(io, '/x/state.json', S.emptyState());
    assert.deepEqual(calls, [
        ['write', '/x/state.json.tmp', true],
        ['rename', '/x/state.json.tmp', '/x/state.json'],
    ]);
});

test('serializeState writes compact JSON with one trailing newline', () => {
    const state = { version: 1, windows: [{ id: 'a', key: 'k', rel: { x: 1, y: 2, w: 3, h: 4 } }] };
    const text = S.serializeState(state);
    assert.equal(text, JSON.stringify(state) + '\n');
    assert.equal(text.indexOf('\n'), text.length - 1);
    assert.deepEqual(JSON.parse(text), state);
});

test('saveState does not rename when the write fails', () => {
    const calls = [];
    const io = { read() {}, write() { throw new Error('ENOSPC'); }, rename: () => calls.push('rename') };
    assert.throws(() => S.saveState(io, '/x/state.json', S.emptyState()));
    assert.deepEqual(calls, []);
});

test('entriesForKey returns matching entries, newest first', () => {
    const st = { version: 1, windows: [entry('a', 'k', 1), entry('b', 'k', 3), entry('c', 'other', 9)] };
    assert.deepEqual(S.entriesForKey(st, 'k').map(e => e.id), ['b', 'a']);
});

test('upsertEntry replaces by id and appends new ids', () => {
    let st = { version: 1, windows: [entry('a', 'k', 1)] };
    st = S.upsertEntry(st, entry('a', 'k', 5));
    st = S.upsertEntry(st, entry('b', 'k', 2));
    assert.equal(st.windows.length, 2);
    assert.equal(st.windows.find(e => e.id === 'a').lastSeen, 5);
});

test('removeEntry drops only the given id', () => {
    const st = { version: 1, windows: [entry('a', 'k', 1), entry('b', 'k', 2)] };
    assert.deepEqual(S.removeEntry(st, 'a').windows.map(e => e.id), ['b']);
});

test('pruneState keeps the newest entries up to max', () => {
    const st = { version: 1, windows: [entry('a', 'k', 1), entry('b', 'k', 3), entry('c', 'k', 2)] };
    assert.deepEqual(S.pruneState(st, 2).windows.map(e => e.id).sort(), ['b', 'c']);
    assert.equal(S.pruneState(st, 10), st);
});

test('newEntryId has a timestamp prefix and depends on the random source', () => {
    assert.match(S.newEntryId(1000, () => 0.5), /^rs-[0-9a-z]+$/);
    assert.notEqual(S.newEntryId(1000, () => 0.1), S.newEntryId(1000, () => 0.2));
});

test('parseState keeps the first entry of an id that appears twice, so that one id is one entry', () => {
    const entry = (id, over) => Object.assign({
        id: id, key: 'a|a', lastSeen: 1, workspace: 0, maximized: false, monitor: null, rel: null, role: '',
    }, over || {});
    const text = JSON.stringify({ version: 1, windows: [entry('1'), entry('2', { lastSeen: 5 }), entry('2', { lastSeen: 9 })] });
    const r = S.parseState(text);
    assert.deepEqual(r.state.windows.map(e => [e.id, e.lastSeen]), [['1', 1], ['2', 5]]);
});

test('entriesForKeys finds the entries of several keys, newest first', () => {
    const Store = require('../files/window-memory@bootkicker/lib/store.js');
    const state = { version: 1, windows: [
        { id: 'a', key: 'k1', lastSeen: 5 }, { id: 'b', key: 'k2', lastSeen: 9 }, { id: 'c', key: 'k3', lastSeen: 7 },
        { id: 'd', key: 'k1', lastSeen: 8 },
    ] };
    assert.deepEqual(Store.entriesForKeys(state, ['k1', 'k2']).map(e => e.id), ['b', 'd', 'a']);
    assert.deepEqual(Store.entriesForKeys(state, []), []);
});

test('parseState keeps appId and client when they are valid and removes wrong values', () => {
    const Store = require('../files/window-memory@bootkicker/lib/store.js');
    const base = { key: 'k|k', lastSeen: 1, rel: null, monitor: null, maximized: false, workspace: null };
    const text = JSON.stringify({ version: 1, windows: [
        Object.assign({ id: 'a', appId: 'x.desktop', client: 'wayland' }, base),
        Object.assign({ id: 'b', appId: 7, client: 'weird' }, base),
        Object.assign({ id: 'c' }, base),
    ] });
    const { state } = Store.parseState(text);
    const by = id => state.windows.find(e => e.id === id);
    assert.equal(by('a').appId, 'x.desktop');
    assert.equal(by('a').client, 'wayland');
    assert.ok(!('appId' in by('b')) && !('client' in by('b'))); // wrong values read as absent
    assert.ok(!('appId' in by('c')) && !('client' in by('c'))); // an old entry stays as it is
});
