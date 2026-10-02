import test from 'node:test';
import assert from 'node:assert/strict';
import { commentaryPreparation } from '../src/preparation-state.js';

test('disabled waits; missing coverage or invalid time keeps preparation pending', () => {
  assert.deepEqual(commentaryPreparation({ enabled: false, time: 10, coverage: [[0, 90]] }),
    { state: 'waiting', ahead: 0, readyUntil: 10 });
  assert.deepEqual(commentaryPreparation({ enabled: true, time: 10 }),
    { state: 'preparing', ahead: 0, readyUntil: 10 });
  assert.deepEqual(commentaryPreparation({ enabled: true, time: NaN, coverage: [[0, 90]] }),
    { state: 'preparing', ahead: 0, readyUntil: null });
});

test('verified silence and contiguous overlapping segments count without mutating inputs', () => {
  const coverage = [[30, 70], [0, 20], [20, 40]];
  assert.deepEqual(commentaryPreparation({ enabled: true, time: 10, coverage }),
    { state: 'ready', ahead: 60, readyUntil: 70 });
  assert.deepEqual(coverage, [[30, 70], [0, 20], [20, 40]]);
});

test('untranslated future speech blocks at its beginning and active speech blocks immediately', () => {
  const input = { enabled: true, time: 10, coverage: [[0, 90]] };
  assert.deepEqual(commentaryPreparation({ ...input, cues: [{ start: 40, end: 45, status: 'queued', zh: null }] }),
    { state: 'preparing', ahead: 30, readyUntil: 40 });
  assert.deepEqual(commentaryPreparation({ ...input, cues: [{ start: 9, end: 12, status: 'failed', zh: null }] }),
    { state: 'preparing', ahead: 0, readyUntil: 10 });
  assert.equal(commentaryPreparation({ ...input, cues: [{ start: 40, end: 45, status: 'ready', zh: '  ' }] }).readyUntil, 40);
  assert.equal(commentaryPreparation({ ...input, cues: [{ start: 40, end: 45, status: 'queued', zh: '已译' }] }).readyUntil, 40);
});

test('past failures do not block and distant translated speech cannot bridge unread gaps', () => {
  const cues = [{ start: 0, end: 10, status: 'failed', zh: null }, { start: 70, end: 80, status: 'ready', zh: '已译' }];
  assert.deepEqual(commentaryPreparation({ enabled: true, time: 10, coverage: [[0, 30], [40, 90]], cues }),
    { state: 'preparing', ahead: 20, readyUntil: 30 });
  assert.equal(commentaryPreparation({ enabled: true, time: 10, coverage: [[0, 90]], cues }).state, 'ready');
  assert.equal(commentaryPreparation({ enabled: true, time: 10, coverage: [[40, 90]], cues }).ahead, 0);
});

test('45 seconds is ready with only tiny floating tolerance; shorter source ending remains pending', () => {
  assert.equal(commentaryPreparation({ enabled: true, time: 10, coverage: [[0, 55]] }).state, 'ready');
  assert.equal(commentaryPreparation({ enabled: true, time: 10, coverage: [[0, 54.9999999]] }).state, 'ready');
  assert.equal(commentaryPreparation({ enabled: true, time: 10, coverage: [[0, 54.99]] }).state, 'preparing');
  assert.deepEqual(commentaryPreparation({ enabled: true, time: 60, coverage: [[0, 90]] }),
    { state: 'preparing', ahead: 30, readyUntil: 90 });
});
