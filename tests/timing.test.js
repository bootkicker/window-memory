const test = require('node:test');
const assert = require('node:assert/strict');
const { lib } = require('./helpers/load-cinnamon-module.js');
const T = lib('timing');

function fakeSched() {
    const timers = new Map();
    let next = 1;
    return {
        timers: timers,
        setTimeout(fn) { const id = next++; timers.set(id, fn); return id; },
        clearTimeout(id) { timers.delete(id); },
        runAll() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
    };
}

test('debouncer fires once after repeated calls', () => {
    const s = fakeSched();
    let n = 0;
    const d = T.createDebouncer(1000, () => n++, s);
    d.call(); d.call(); d.call();
    assert.equal(s.timers.size, 1);
    s.runAll();
    assert.equal(n, 1);
});

test('flush runs a pending call now; cancel drops it; flush with nothing pending does nothing', () => {
    const s = fakeSched();
    let n = 0;
    const d = T.createDebouncer(1000, () => n++, s);
    d.call(); d.flush();
    assert.equal(n, 1);
    assert.equal(s.timers.size, 0);
    d.call(); d.cancel(); s.runAll();
    assert.equal(n, 1);
    d.flush();
    assert.equal(n, 1);
});
