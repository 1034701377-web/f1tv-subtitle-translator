import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserAsr, cleanupBrowserAsrRules } from '../extension/browser-asr.js';

const config = { endpoint: 'wss://speech.example/inference', apiKey: 'speech-fixture-secret',
  model: 'qwen-audio-3.1-asr-flash-streaming', timeoutMs: 1000 };
const input = { sampleRate: 16000, start: 2040, audioBase64: Buffer.alloc(32000).toString('base64') };
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture({ autoOpen = true, autoStarted = true, holdBinary = false, onFinish, allowed = true } = {}) {
  const sockets = [], updates = [], rules = new Map();
  const chromeApi = { runtime: { id: 'a'.repeat(32) }, permissions: { async contains() { return allowed; } },
    declarativeNetRequest: {
      async getSessionRules() { return [...rules.values()]; },
      async updateSessionRules(update) {
        updates.push(update);
        for (const id of update.removeRuleIds ?? []) rules.delete(id);
        for (const rule of update.addRules ?? []) rules.set(rule.id, rule);
      },
    } };
  class FakeSocket {
    constructor(endpoint) {
      this.endpoint = endpoint; this.readyState = 0; this.bufferedAmount = 0; this.frames = []; this.listeners = new Map(); this.maxBuffered = 0;
      assert.equal(rules.size, 1, 'authorization must be installed before connecting');
      sockets.push(this);
      if (autoOpen) queueMicrotask(() => { this.readyState = 1; this.emit('open'); });
    }
    addEventListener(type, callback) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(callback);
    }
    emit(type, event = {}) { for (const callback of this.listeners.get(type) ?? []) callback(event); }
    event(event, payload = {}, header = {}) {
      this.emit('message', { data: JSON.stringify({ header: { task_id: this.taskId, event, ...header }, payload }) });
    }
    sentence(sentence, usage) { this.event('result-generated', { output: { sentence }, usage }); }
    send(data) {
      this.frames.push(data);
      if (typeof data === 'string') {
        const message = JSON.parse(data); this.taskId = message.header.task_id;
        if (message.header.action === 'run-task' && autoStarted) queueMicrotask(() => this.event('task-started'));
        if (message.header.action === 'finish-task') queueMicrotask(() => onFinish?.(this));
      } else if (holdBinary) {
        this.bufferedAmount += data.byteLength;
        this.maxBuffered = Math.max(this.maxBuffered, this.bufferedAmount);
      }
    }
    close() { this.readyState = 3; this.closed = true; this.emit('close'); }
  }
  return { chromeApi, WebSocketImpl: FakeSocket, sockets, updates, rules };
}

test('browser sends bounded native PCM frames, final cues and cumulative usage; auth is exact and temporary', async () => {
  const received = [];
  const f = fixture({ onFinish(socket) {
    socket.sentence({ sentence_id: 1, text: 'draft', sentence_end: false });
    socket.sentence({ text: 'heartbeat', sentence_end: true, heartbeat: true });
    socket.sentence({ sentence_id: 2, begin_time: 100, end_time: 700, text: 'Box now.', sentence_end: true }, { total_tokens: 10 });
    socket.sentence({ sentence_id: 2, begin_time: 100, end_time: 700, text: 'Do not revise final.', sentence_end: true });
    socket.event('task-finished', { usage: { total_tokens: 12, duration: 1, secret: config.apiKey } });
  } });
  const result = await createBrowserAsr(config, f).transcribe(input, { onCue: cue => received.push(cue) });
  assert.deepEqual(result, { cues: [{ text: 'Box now.', start: 2040.1, end: 2040.7 }], usage: { total_tokens: 12, duration: 1 } });
  assert.deepEqual(received, result.cues); assert.equal(Object.isFrozen(received[0]), true);
  const rule = f.updates[0].addRules[0];
  assert.deepEqual(rule.condition, { urlFilter: '|wss://speech.example/inference|', isUrlFilterCaseSensitive: true,
    initiatorDomains: ['a'.repeat(32)], resourceTypes: ['websocket'] });
  assert.deepEqual(rule.action, { type: 'modifyHeaders', requestHeaders: [{ header: 'Authorization', operation: 'set', value: `Bearer ${config.apiKey}` }] });
  assert.deepEqual(f.updates.at(-1), { removeRuleIds: [rule.id] }); assert.equal(f.rules.size, 0);
  const [socket] = f.sockets, audioFrames = socket.frames.filter(value => typeof value !== 'string');
  assert.equal(audioFrames.length, 10); assert.ok(audioFrames.every(value => value instanceof Uint8Array && value.byteLength === 3200));
  assert.equal(socket.closed, true); assert.doesNotMatch(JSON.stringify(socket.frames.filter(value => typeof value === 'string')), /fixture-secret/);
});

test('word timing splits final English sentences without merging apostrophe fragments', async () => {
  const w = (text, begin_time, end_time, punctuation = '') => ({ text, begin_time, end_time, punctuation, fixed: true });
  const words = [w('That', 100, 200), w("'s", 200, 250), w(' good', 250, 500, '.'), w(' Box', 600, 750), w(' now', 750, 900, '!')];
  const f = fixture({ onFinish(socket) {
    socket.sentence({ sentence_id: 7, begin_time: 100, end_time: 900, text: "That's good. Box now!", sentence_end: true, words });
    socket.event('task-finished');
  } });
  const result = await createBrowserAsr(config, f).transcribe(input);
  assert.deepEqual(result.cues, [
    { text: "That's good.", start: 2040.1, end: 2040.5, id: 'asr:2040:100:900:7:part:0' },
    { text: 'Box now!', start: 2040.6, end: 2040.9, id: 'asr:2040:100:900:7:part:1' },
  ]);
});

test('abort before connect, during handshake, send backpressure and after first cue cleans authorization', async () => {
  const unopened = fixture();
  await assert.rejects(createBrowserAsr(config, unopened).transcribe(input, { signal: AbortSignal.abort() }), { code: 'CANCELLED' });
  assert.equal(unopened.updates.length, 0);
  for (const options of [{ autoOpen: false }, { holdBinary: true }]) {
    const f = fixture(options), controller = new AbortController();
    const task = createBrowserAsr(config, f).transcribe({ ...input, audioBase64: Buffer.alloc(96000).toString('base64') }, { signal: controller.signal });
    await tick(); controller.abort();
    await assert.rejects(task, { code: 'CANCELLED', status: 499 });
    assert.equal(f.rules.size, 0); assert.equal(f.sockets[0].closed, true);
    assert.ok(f.sockets[0].maxBuffered <= 65536);
    f.sockets[0].emit('error', { message: config.apiKey });
  }
  const controller = new AbortController(), received = [];
  const f = fixture({ onFinish(socket) {
    socket.sentence({ text: 'First', begin_time: 0, end_time: 500, sentence_end: true });
    socket.sentence({ text: 'Second', begin_time: 500, end_time: 900, sentence_end: true });
  } });
  await assert.rejects(createBrowserAsr(config, f).transcribe(input, { signal: controller.signal,
    onCue(cue) { received.push(cue); controller.abort(); } }), { code: 'CANCELLED' });
  assert.equal(received.length, 1); assert.equal(f.rules.size, 0);
});

test('connect, start, send and finish timeouts are explicit and have redacted diagnostics', async () => {
  for (const [options, code] of [[{ autoOpen: false }, 'ASR_CONNECT_TIMEOUT'], [{ autoStarted: false }, 'ASR_START_TIMEOUT'],
    [{ holdBinary: true }, 'ASR_SEND_TIMEOUT'], [{}, 'ASR_FINISH_TIMEOUT']]) {
    const f = fixture(options);
    await assert.rejects(createBrowserAsr({ ...config, timeoutMs: 50 }, f).transcribe({ ...input, audioBase64: Buffer.alloc(96000).toString('base64') }), error => {
      assert.equal(error.code, code); assert.equal(error.status, 504);
      assert.doesNotMatch(JSON.stringify(error), /speech\.example|fixture-secret/);
      assert.ok(Number.isFinite(error.diagnostics.elapsedMs)); return true;
    });
    assert.equal(f.rules.size, 0); assert.equal(f.sockets[0].closed, true);
    assert.ok(f.sockets[0].maxBuffered <= 65536);
  }
});

test('invalid responses fail safely and remove the rule, never returning partial success', async () => {
  for (const response of [
    socket => socket.emit('message', { data: new Uint8Array([1]) }),
    socket => socket.emit('message', { data: config.apiKey }),
    socket => socket.emit('message', { data: ' '.repeat(65537) }),
    socket => socket.event('task-finished', {}, { task_id: 'wrong' }),
    socket => socket.event('task-started'),
    socket => socket.event('unknown-event'),
    socket => socket.sentence({ text: 'Outside', begin_time: 0, end_time: 1001, sentence_end: true }),
    socket => socket.sentence({ text: 7, begin_time: 0, end_time: 500, sentence_end: true }),
  ]) {
    const f = fixture({ onFinish: response });
    await assert.rejects(createBrowserAsr(config, f).transcribe(input), { code: 'ASR_INVALID_RESPONSE', message: 'ASR_INVALID_RESPONSE' });
    assert.equal(f.rules.size, 0);
  }
  const f = fixture({ onFinish(socket) { socket.sentence({ text: 'First', begin_time: 0, end_time: 500, sentence_end: true }); socket.close(); } });
  await assert.rejects(createBrowserAsr(config, f).transcribe(input), { code: 'ASR_CONNECTION_CLOSED' });
  assert.equal(f.rules.size, 0);
});

test('only one ASR request owns a rule and a later request has independent cleanup', async () => {
  const f = fixture({ autoOpen: false }), controller = new AbortController();
  const first = createBrowserAsr(config, f).transcribe(input, { signal: controller.signal });
  await tick();
  await assert.rejects(createBrowserAsr(config, f).transcribe(input), { code: 'ASR_BUSY' });
  assert.equal(f.sockets.length, 1); assert.equal(f.rules.size, 1);
  controller.abort(); await assert.rejects(first, { code: 'CANCELLED' });
  const secondAbort = new AbortController(), second = createBrowserAsr(config, f).transcribe(input, { signal: secondAbort.signal });
  await tick(); secondAbort.abort(); await assert.rejects(second, { code: 'CANCELLED' });
  assert.equal(f.rules.size, 0);
});

test('missing permission and invalid audio never install auth or connect', async () => {
  const denied = fixture({ allowed: false });
  await assert.rejects(createBrowserAsr(config, denied).transcribe(input), { code: 'HOST_PERMISSION_REQUIRED' });
  assert.equal(denied.updates.length, 0); assert.equal(denied.sockets.length, 0);
  const f = fixture();
  for (const change of [{ sampleRate: 44100 }, { start: -1 }, { audioBase64: 'YQ==' },
    { audioBase64: 'AAAA====' }, { audioBase64: Buffer.alloc(960002).toString('base64') }]) {
    await assert.rejects(createBrowserAsr(config, f).transcribe({ ...input, ...change }), { code: 'ASR_INVALID_AUDIO' });
  }
  assert.equal(f.updates.length, 0);
});

test('startup cleanup removes only this feature session-rule range', async () => {
  const f = fixture(); f.rules.set(1900000001, { id: 1900000001 }); f.rules.set(7, { id: 7 });
  await cleanupBrowserAsrRules(f.chromeApi);
  assert.deepEqual([...f.rules.keys()], [7]);
});

test('cancellation during asynchronous rule installation still removes the installed rule', async () => {
  const f = fixture(), original = f.chromeApi.declarativeNetRequest.updateSessionRules;
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  f.chromeApi.declarativeNetRequest.updateSessionRules = async update => {
    if (update.addRules) await barrier;
    return original(update);
  };
  const controller = new AbortController(), task = createBrowserAsr(config, f).transcribe(input, { signal: controller.signal });
  await tick(); controller.abort(); release();
  await assert.rejects(task, { code: 'CANCELLED' });
  assert.equal(f.sockets.length, 0); assert.equal(f.rules.size, 0);
});
