const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../files/window-memory@bootkicker/lib/safety.js');

test('parseSafety of null, \'\', \'not json\', \'[]\', \'{"stopped": 5}\', \'{"starts": "x"}\' gives emptySafety()', () => {
    for (const input of [null, '', 'not json', '[]', '{"stopped": 5}', '{"starts": "x"}']) {
        assert.deepEqual(S.parseSafety(input), S.emptySafety(), String(input));
    }
});

test('parseSafety drops a stopped without a known reason and keeps the valid starts', () => {
    const noReason = JSON.stringify({ stopped: { at: 5 }, starts: [{ at: 1, session: 'a' }] });
    assert.deepEqual(S.parseSafety(noReason), { stopped: null, starts: [{ at: 1, session: 'a' }] });
    const badReason = JSON.stringify({
        stopped: { reason: 'because', at: 5 },
        starts: [{ at: 1, session: 'a' }, { at: 'x', session: 'a' }, { at: 2 }, { at: 3, session: 'b' }],
    });
    assert.deepEqual(S.parseSafety(badReason), {
        stopped: null,
        starts: [{ at: 1, session: 'a' }, { at: 3, session: 'b' }],
    });
});

test('parseSafety turns an unknown resume into \'switch\'', () => {
    const make = resume => JSON.stringify({
        stopped: { reason: S.REASONS.RESTART_LOOP, at: 9, cinnamon: '6.4', muffin: '6.4', resume },
        starts: [],
    });
    assert.equal(S.parseSafety(make('file')).stopped.resume, 'file');
    assert.equal(S.parseSafety(make('switch')).stopped.resume, 'switch');
    assert.equal(S.parseSafety(make('whatever')).stopped.resume, 'switch');
    assert.equal(S.parseSafety(make(undefined)).stopped.resume, 'switch');
});

test('serializeSafety then parseSafety round-trips a stopped record and starts', () => {
    const safety = S.stopSafety(
        S.recordStart(S.recordStart(S.emptySafety(), 100, 's1'), 130, 's1'),
        S.stopRecord(S.REASONS.MISSING_CALL, 140, '6.4.8', '6.4.2', 'file'));
    assert.deepEqual(S.parseSafety(S.serializeSafety(safety)), safety);
    assert.equal(safety.stopped.reason, 'missing-call');
    assert.equal(safety.stopped.resume, 'file');
});

test('serializeSafety ends with a newline', () => {
    assert.ok(S.serializeSafety(S.emptySafety()).endsWith('\n'));
});

test('the budget reaches the limit at the 20th error within 300 s, not at the 19th', () => {
    const b = S.createErrorBudget(S.LIMITS.errorLimit, S.LIMITS.errorWindowSeconds);
    for (let t = 0; t < 19; t++) assert.equal(b.record(t), false, 'error ' + (t + 1));
    assert.equal(b.record(19), true);
});

test('the budget forgets errors older than 300 s', () => {
    const b = S.createErrorBudget(20, 300);
    for (let i = 0; i < 19; i++) assert.equal(b.record(0), false);
    assert.equal(b.record(301), false);
});

test('a record exactly windowSeconds old is outside the window', () => {
    const b = S.createErrorBudget(2, 300);
    assert.equal(b.record(0), false);
    assert.equal(b.record(300), false);
    assert.equal(b.record(599), true);
});

test('reset empties the budget', () => {
    const b = S.createErrorBudget(3, 300);
    b.record(0);
    b.record(1);
    b.reset();
    assert.equal(b.record(2), false);
    assert.equal(b.record(3), false);
    assert.equal(b.record(4), true);
});

test('recordStart keeps only the last 10', () => {
    let s = S.emptySafety();
    for (let i = 0; i < 15; i++) s = S.recordStart(s, i, 's');
    assert.equal(s.starts.length, 10);
    assert.equal(s.starts[0].at, 5);
    assert.equal(s.starts[9].at, 14);
});

test('recordStart does not change its input', () => {
    const s = S.emptySafety();
    S.recordStart(s, 1, 'a');
    assert.deepEqual(s, S.emptySafety());
});

function withStarts(list) {
    return { stopped: null, starts: list.map(([at, session]) => ({ at, session })) };
}

test('isRestartLoop is false for two starts, true for three in one session within 120 s gaps', () => {
    assert.equal(S.isRestartLoop(withStarts([[0, 'a'], [60, 'a']]), 3, 120), false);
    assert.equal(S.isRestartLoop(withStarts([[0, 'a'], [60, 'a'], [120, 'a']]), 3, 120), true);
});

test('isRestartLoop is false when a gap is 121 s', () => {
    assert.equal(S.isRestartLoop(withStarts([[0, 'a'], [121, 'a'], [150, 'a']]), 3, 120), false);
    assert.equal(S.isRestartLoop(withStarts([[0, 'a'], [30, 'a'], [151, 'a']]), 3, 120), false);
});

test('isRestartLoop is false when the clock went backwards between two starts (a negative gap breaks the chain)', () => {
    assert.equal(S.isRestartLoop(withStarts([[0, 'a'], [60, 'a'], [30, 'a']]), 3, 120), false);
    assert.equal(S.isRestartLoop(withStarts([[100, 'a'], [50, 'a'], [80, 'a']]), 3, 120), false);
    assert.equal(S.isRestartLoop(withStarts([[0, 'a'], [0, 'a'], [0, 'a']]), 3, 120), true, 'a gap of 0 s is still a short gap');
});

test('isRestartLoop is false when the session changes in the middle (a logout)', () => {
    assert.equal(S.isRestartLoop(withStarts([[0, 'a'], [30, 'b'], [60, 'a']]), 3, 120), false);
});

test('isRestartLoop treats an empty session as any session', () => {
    assert.equal(S.isRestartLoop(withStarts([[0, ''], [30, 'a'], [60, 'a']]), 3, 120), true);
    assert.equal(S.isRestartLoop(withStarts([[0, 'a'], [30, ''], [60, 'a']]), 3, 120), true);
    assert.equal(S.isRestartLoop(withStarts([[0, 'a'], [30, ''], [60, 'b']]), 3, 120), false);
});

test('isRestartLoop only looks at the last loopStarts entries', () => {
    assert.equal(S.isRestartLoop(withStarts([[0, 'x'], [1000, 'a'], [1030, 'a'], [1060, 'a']]), 3, 120), true);
});

test('afterCleanDisable empties starts and keeps stopped', () => {
    const stopped = S.stopRecord(S.REASONS.TOO_MANY_ERRORS, 5, 'c', 'm', 'switch');
    const s = S.afterCleanDisable(S.stopSafety(S.recordStart(S.emptySafety(), 1, 'a'), stopped));
    assert.deepEqual(s.starts, []);
    assert.deepEqual(s.stopped, stopped);
});

test('stopSafety sets stopped and keeps starts', () => {
    const stopped = S.stopRecord(S.REASONS.START_FAILED, 5, 'c', 'm', 'switch');
    const s = S.stopSafety(S.recordStart(S.emptySafety(), 1, 'a'), stopped);
    assert.deepEqual(s.stopped, stopped);
    assert.deepEqual(s.starts, [{ at: 1, session: 'a' }]);
});

test('resumeSafety clears both', () => {
    assert.deepEqual(S.resumeSafety(), { stopped: null, starts: [] });
});

test('LIMITS and REASONS carry the documented values', () => {
    assert.deepEqual(S.LIMITS, { errorLimit: 20, errorWindowSeconds: 300, loopStarts: 3, loopGapSeconds: 120 });
    assert.deepEqual(S.REASONS, {
        MISSING_CALL: 'missing-call', START_FAILED: 'start-failed',
        TOO_MANY_ERRORS: 'too-many-errors', RESTART_LOOP: 'restart-loop',
    });
});
