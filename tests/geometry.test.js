const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../files/window-memory@bootkicker/lib/geometry.js');

const monitors = [
    { index: 0, x: 0, y: 0, w: 1920, h: 1080, primary: true },
    { index: 1, x: 1920, y: 0, w: 1920, h: 1080, primary: false },
];

test('toRelative and toAbsolute round-trip on an offset monitor', () => {
    const mon = { x: 1920, y: 0, w: 1920, h: 1080 };
    const rect = { x: 2020, y: 40, w: 800, h: 600 };
    const rel = G.toRelative(rect, mon);
    assert.deepEqual(rel, { x: 100, y: 40, w: 800, h: 600 });
    assert.deepEqual(G.toAbsolute(rel, mon), rect);
});

test('clampRect moves or shrinks a rect so it lies fully inside the area', () => {
    const area = { x: 0, y: 30, w: 1920, h: 1050 };
    assert.deepEqual(G.clampRect({ x: -50, y: 0, w: 800, h: 600 }, area), { x: 0, y: 30, w: 800, h: 600 });
    assert.deepEqual(G.clampRect({ x: 1800, y: 900, w: 400, h: 300 }, area), { x: 1520, y: 780, w: 400, h: 300 });
    assert.deepEqual(G.clampRect({ x: 0, y: 0, w: 3000, h: 2000 }, area), { x: 0, y: 30, w: 1920, h: 1050 });
});

test('chooseMonitor prefers an exact geometry match', () => {
    assert.equal(G.chooseMonitor(monitors, { index: 0, x: 1920, y: 0, w: 1920, h: 1080 }).index, 1);
});

test('chooseMonitor falls back to the same index when geometry changed', () => {
    assert.equal(G.chooseMonitor(monitors, { index: 1, x: 0, y: 0, w: 2560, h: 1440 }).index, 1);
});

test('chooseMonitor falls back to the primary monitor when the saved one is gone', () => {
    assert.equal(G.chooseMonitor(monitors, { index: 5, x: 0, y: 0, w: 800, h: 600 }).index, 0);
    assert.equal(G.chooseMonitor(monitors, null).index, 0);
});

test('chooseMonitor returns null when there are no monitors', () => {
    assert.equal(G.chooseMonitor([], null), null);
});

test('isConnected is true for the same geometry, and for the same index at the same origin (the resolution changed)', () => {
    assert.equal(G.isConnected(monitors, { index: 1, x: 1920, y: 0, w: 1920, h: 1080 }), true);
    assert.equal(G.isConnected(monitors, { index: 0, x: 0, y: 0, w: 2560, h: 1440 }), true);
    // Another monitor with the same size and place, whatever its index (the monitors were numbered again).
    assert.equal(G.isConnected(monitors, { index: 7, x: 1920, y: 0, w: 1920, h: 1080 }), true);
});

test('isConnected is false when only the index matches: Muffin numbers the monitors again after an unplug', () => {
    // The monitor that was index 0 at x 3840 is unplugged; the monitor now numbered 0 is the one at x 0.
    assert.equal(G.isConnected(monitors, { index: 0, x: 3840, y: 0, w: 1920, h: 1080 }), false);
    assert.equal(G.isConnected(monitors, { index: 5, x: 0, y: 0, w: 800, h: 600 }), false);
    assert.equal(G.isConnected(monitors, null), false);
    assert.equal(G.isConnected([], { index: 0, x: 0, y: 0, w: 1920, h: 1080 }), false);
});
