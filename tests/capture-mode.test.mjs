import test from 'node:test';
import assert from 'node:assert/strict';
import { capturePageInfo, captureStartProblem, validCaptureClock } from '../src/capture-mode.js';

const base = 'https://f1tv.formula1.com/detail/1000010360/qualifying';
const live = capturePageInfo(`${base}?f1zh-capture=1`);
const replay = capturePageInfo(`${base}?f1zh-capture=1&f1zh-replay=1`);
const sample = { collector: true, programmeId: replay.programmeId, eventType: 'vod', time: 2040, origin: 0,
  at: 1e12, epoch: 1, paused: false, muted: false, rate: 1, trackFx: true, behindLive: null };

test('replay requires explicit opt-in and is isolated by programme and mode', () => {
  assert.notEqual(live.programmeId, replay.programmeId);
  assert.notEqual(replay.programmeId, capturePageInfo(`${base.replace('1000010360', '123')}?f1zh-replay=1`).programmeId);
  assert.equal(capturePageInfo('https://example.com/detail/123?f1zh-replay=1'), null);
  assert.match(captureStartProblem(live, sample), /这是回放/);
});
test('VOD uses real programme seconds with zero origin and no live-edge requirement', () => {
  assert.equal(validCaptureClock(sample, replay), true);
  assert.equal(captureStartProblem(replay, sample), null);
  assert.equal(validCaptureClock({ ...sample, origin: 1.7e9 }, replay), false);
  assert.equal(validCaptureClock({ ...sample, eventType: 'live' }, replay), false);
  assert.equal(validCaptureClock({ ...sample, time: -1 }, replay), false);
});
test('capture still requires the selected collector, Track FX and normal playback', () => {
  assert.ok(captureStartProblem(capturePageInfo(`${base}?f1zh-replay=1`), sample));
  for (const change of [{ collector: false }, { trackFx: false }, { paused: true }, { muted: true }, { rate: 2 }]) {
    assert.ok(captureStartProblem(replay, { ...sample, ...change }));
  }
});
test('live capture retains the validated absolute origin and live-edge guard', () => {
  const clock = { ...sample, programmeId: live.programmeId, eventType: 'live', origin: 1.7e9, behindLive: 3 };
  assert.equal(captureStartProblem(live, clock), null);
  assert.ok(captureStartProblem(live, { ...clock, origin: 0 }));
  assert.ok(captureStartProblem(live, { ...clock, behindLive: 50 }));
});
