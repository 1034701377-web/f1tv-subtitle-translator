import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { CueStore, TranslationQueue } from '../src/core.js';
import { TabAudioSource } from '../src/tab-audio-source.js';
import { ProgrammeRelay } from '../src/programme-relay.js';
import { validCaptureSnapshot } from '../src/capture-protocol.js';

const source = (await readFile(new URL('../extension/offscreen-entry.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '');
const token = 'test-secret-pairing-token';
const streamId = 'test-private-stream-id';
const privateUrl = 'https://media.invalid/private-resource';

// Chromium rejects legacy mandatory/optional combined with standard audio
// constraints before it attempts to open a device or resolve a stream ID.
function checkBrowserConstraints(options) {
  if (options.audio?.mandatory && ['echoCancellation', 'noiseSuppression', 'autoGainControl', 'sampleRate', 'channelCount']
    .some(key => Object.hasOwn(options.audio, key))) {
    throw TypeError('Malformed constraint: Cannot use both optional/mandatory and specific or advanced constraints.');
  }
}

function fixture(t, { rejectMediaOnce = false, rejectWorkletOnce = false, controlled = false, pageOffset = 0 } = {}) {
  let listener, session = 0, networkCalls = 0;
  const mediaRequests = [], streams = [], contexts = [], nodes = [], messages = [], pcmChunks = [];
  let elapsed = 0, timerId = 0, clockReply = () => null;
  const deadlines = new Map(), epoch = 1791000000000;
  const localNow = () => controlled ? epoch + elapsed : performance.timeOrigin + performance.now();
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const timerApi = controlled ? {
    setTimeout(fn, delay) { const id = ++timerId; deadlines.set(id, { fn, at: elapsed + delay }); return id; },
    clearTimeout(id) { deadlines.delete(id); },
    setInterval() { return ++timerId; }, clearInterval() {},
  } : { setTimeout, clearTimeout, setInterval, clearInterval };
  const snapshot = changes => ({ protocol: 1, programmeId: controlled ? '1000010360:live' : '1000010360:vod-test',
    time: 2200 + elapsed / 1000, origin: controlled ? 1791000645.12 : 0, at: localNow() + pageOffset,
    epoch: 1, rate: 1, paused: false, muted: false, problem: null, startProblem: null, ...changes });
  class ObservedSource extends TabAudioSource {
    pushPcm(samples, start, rate) { pcmChunks.push({ start, length: samples.length, rate }); super.pushPcm(samples, start, rate); }
  }
  const mediaError = new TypeError(`private details ${token} ${streamId} ${privateUrl}`);
  const moduleError = Object.assign(Error(`private details ${token} ${streamId} ${privateUrl}`), { name: 'NotSupportedError' });
  const navigator = { mediaDevices: { async getUserMedia(options) {
    mediaRequests.push(structuredClone(options));
    checkBrowserConstraints(options);
    if (rejectMediaOnce) { rejectMediaOnce = false; throw mediaError; }
    const track = { readyState: 'live', stops: 0, addEventListener() {}, stop() { this.stops++; this.readyState = 'ended'; } };
    const stream = { track, getAudioTracks: () => [track], getTracks: () => [track] };
    streams.push(stream);
    return stream;
  } } };
  class AudioContext {
    constructor(options) {
      this.sampleRate = options?.sampleRate || 48000;
      this.currentTime = 0;
      this.state = 'suspended';
      this.destination = {};
      this.closes = 0;
      this.audioWorklet = { addModule: async () => {
        if (rejectWorkletOnce) { rejectWorkletOnce = false; throw moduleError; }
      } };
      contexts.push(this);
    }
    async resume() { this.state = 'running'; }
    async close() { this.closes++; this.state = 'closed'; }
    createMediaStreamSource(stream) {
      assert.ok(streams.includes(stream));
      const node = { connections: [], disconnects: 0, connect(destination) { this.connections.push(destination); }, disconnect() { this.disconnects++; } };
      nodes.push(node);
      return node;
    }
  }
  class AudioWorkletNode {
    constructor(context, name) {
      assert.ok(contexts.includes(context));
      assert.equal(name, 'track-pcm');
      this.port = { onmessage: null, postMessage() {} };
      this.disconnects = 0;
      nodes.push(this);
    }
    connect() {}
    disconnect() { this.disconnects++; }
  }
  const chrome = { runtime: {
    id: 'test-extension',
    onMessage: { addListener(value) { listener = value; } },
    async sendMessage(message) { messages.push(structuredClone(message)); return message.type === 'clock' ? clockReply(message) : null; },
  } };
  const sandbox = vm.createContext({ chrome, navigator, AudioContext, AudioWorkletNode,
    performance: controlled ? { timeOrigin: epoch, now: () => elapsed } : performance,
    CueStore, TranslationQueue, TabAudioSource: ObservedSource, ProgrammeRelay, validCaptureSnapshot,
    extensionRequest() { networkCalls++; throw Error('This clock test must not call a model'); },
    installWebSocketHost() {},
    ...timerApi, AbortController,
    fetch() { networkCalls++; throw Error('This test must not call a network transport'); },
  });
  vm.runInContext(source, sandbox, { filename: 'extension/offscreen-entry.js' });
  const send = message => new Promise(resolve => {
    assert.equal(listener({ to: 'offscreen', ...message }, { id: chrome.runtime.id }, response => resolve(structuredClone(response))), true);
  });
  let currentId;
  const start = () => {
    currentId = `test-session-${++session}`;
    const initial = snapshot();
    return send({ type: 'start', capture: { id: currentId, programmeId: initial.programmeId }, streamId, token, snapshot: initial });
  };
  const stop = () => send({ type: 'stop', id: currentId });
  t.after(async () => { await stop(); assert.equal(networkCalls, 0); });
  return { start, stop, mediaRequests, streams, contexts, nodes, messages, pcmChunks, snapshot, flush,
    reply: fn => { clockReply = fn; },
    clockState: () => structuredClone(vm.runInContext('run && ({clock:run.clock,offset:run.clockOffset,busy:run.clockBusy})', sandbox)),
    async clockChanged() { await send({ type: 'clock-changed', id: currentId }); await flush(); },
    async advance(ms) {
      elapsed += ms;
      for (const [id, item] of [...deadlines]) if (item.at <= elapsed) { deadlines.delete(id); item.fn(); }
      await flush();
    },
    emitPcm(sequence, { contextTime = elapsed / 1000 } = {}) {
      contexts.at(-1).currentTime = contextTime;
      nodes.findLast(node => node.port).port.onmessage({ data: {
        samples: new Float32Array(4096).fill(.25), endFrame: sequence * 4096, sequence,
      } });
    },
  };
}

function noPrivateDiagnostics(response) {
  const value = JSON.stringify(response);
  for (const privateValue of [token, streamId, privateUrl]) assert.equal(value.includes(privateValue), false);
}

test('legacy plus standard constraints reproduce the rejection; the real start uses only tab capture and succeeds', async t => {
  assert.throws(() => checkBrowserConstraints({ audio: {
    mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId }, echoCancellation: false,
  } }), { name: 'TypeError' });
  const f = fixture(t);
  assert.deepEqual(await f.start(), { ok: true });
  assert.equal(f.mediaRequests.length, 1);
  const request = f.mediaRequests[0];
  assert.equal(request.video, false);
  assert.equal(request.audio.mandatory.chromeMediaSource, 'tab');
  assert.equal(request.audio.mandatory.chromeMediaSourceId, streamId);
  assert.deepEqual(Object.keys(request.audio), ['mandatory']);
  assert.equal(f.streams[0].track.readyState, 'live');
  assert.equal(f.contexts[0].state, 'running');
});

test('getUserMedia failure identifies the audio stage, hides private details, and allows another start', async t => {
  const f = fixture(t, { rejectMediaOnce: true });
  const failure = await f.start();
  assert.equal(failure.ok, false);
  assert.match(failure.message, /接入标签页声音/);
  assert.match(failure.message, /TypeError/);
  noPrivateDiagnostics(failure);
  assert.equal(f.streams.length, 0);
  assert.equal(f.contexts.length, 0);
  assert.deepEqual(await f.start(), { ok: true });
  assert.equal(f.mediaRequests.length, 2);
  assert.ok(f.mediaRequests.every(request => request.audio.mandatory.chromeMediaSource === 'tab'));
});

test('worklet load failure identifies its stage, releases acquired resources, and permits retry', async t => {
  const f = fixture(t, { rejectWorkletOnce: true });
  const failure = await f.start();
  assert.equal(failure.ok, false);
  assert.match(failure.message, /加载音频模块/);
  assert.match(failure.message, /NotSupportedError/);
  noPrivateDiagnostics(failure);
  assert.equal(f.streams[0].track.stops, 1);
  assert.equal(f.contexts[0].closes, 1);
  assert.equal(f.contexts[0].state, 'closed');
  assert.deepEqual(await f.start(), { ok: true });
  assert.equal(f.streams.length, 2);
  assert.equal(f.streams[1].track.readyState, 'live');
});

test('explicit stop closes the real processing session and releases its stream and graph', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.start(), { ok: true });
  assert.deepEqual(await f.stop(), { ok: true });
  assert.equal(f.streams[0].track.stops, 1);
  assert.equal(f.contexts[0].closes, 1);
  assert.ok(f.nodes.every(node => node.disconnects === 1));
  assert.deepEqual(await f.start(), { ok: true });
  assert.equal(f.streams[1].track.readyState, 'live');
});

test('live clocks with large positive and negative page offsets feed continuous PCM at official programme times', async t => {
  for (const pageOffset of [-3600000, 3600000]) {
    const f = fixture(t, { controlled: true, pageOffset });
    f.reply(() => f.snapshot());
    assert.deepEqual(await f.start(), { ok: true });
    const initial = f.clockState();
    assert.equal(initial.offset, -pageOffset);
    assert.equal(initial.clock.time, 2200);
    assert.equal(initial.clock.origin, 1791000645.12);
    await f.advance(256); f.emitPcm(1);
    await f.advance(256); f.emitPcm(2);
    await f.clockChanged();
    assert.equal(f.pcmChunks.length, 2);
    assert.ok(Math.abs(f.pcmChunks[0].start - 2200) < .001);
    assert.ok(Math.abs(f.pcmChunks[1].start - 2200.256) < .001);
    assert.ok(f.pcmChunks.every(chunk => chunk.length === 4096 && chunk.rate === 16000));
    const status = f.messages.filter(message => message.type === 'status').at(-1).status;
    assert.ok(Math.abs(status.contentTime - (1791000645.12 + 2200.512)) < .001);
  }
});

test('a clock request times out after 3000 ms, later requests recover, and late or stale replies cannot replace the clock', async t => {
  const f = fixture(t, { controlled: true, pageOffset: 600000 });
  let resolveOld;
  f.reply(() => new Promise(resolve => { resolveOld = resolve; }));
  const starting = f.start();
  await f.flush();
  assert.equal(f.clockState().busy, true);
  await f.advance(2999);
  assert.equal(f.clockState().busy, true);
  await f.advance(1);
  assert.deepEqual(await starting, { ok: true });
  assert.equal(f.clockState().busy, false);
  assert.equal(f.clockState().clock, null);
  f.reply(() => f.snapshot());
  await f.clockChanged();
  const recovered = f.clockState();
  assert.equal(recovered.clock.time, 2203);
  resolveOld(f.snapshot({ time: 9999 }));
  await f.flush();
  assert.deepEqual(f.clockState(), recovered);
  const stale = f.snapshot();
  await f.advance(500);
  f.reply(() => stale);
  await f.clockChanged();
  assert.deepEqual(f.clockState(), recovered);
});

test('a slow first clock response cannot calibrate but a subsequent fast response can', async t => {
  const f = fixture(t, { controlled: true, pageOffset: -600000 });
  let resolveFirst;
  f.reply(() => new Promise(resolve => { resolveFirst = resolve; }));
  const starting = f.start();
  await f.flush();
  await f.advance(600);
  resolveFirst(f.snapshot());
  assert.deepEqual(await starting, { ok: true });
  assert.equal(f.clockState().clock, null);
  assert.equal(f.clockState().offset, undefined);
  f.reply(() => f.snapshot());
  await f.clockChanged();
  assert.equal(f.clockState().offset, 600000);
  assert.equal(f.clockState().clock.time, 2200.6);
});

async function primedAudioFixture(t) {
  const f = fixture(t, { controlled: true });
  f.reply(() => f.snapshot());
  assert.deepEqual(await f.start(), { ok: true });
  await f.advance(256); f.emitPcm(1);
  await f.advance(256); f.emitPcm(2);
  await f.clockChanged();
  assert.equal(f.pcmChunks.length, 2);
  return f;
}

for (const gapSeconds of [5, 11]) {
  test(`a running audio clock that falls ${gapSeconds} seconds behind recovers without timestamping new PCM in the past`, async t => {
    const f = await primedAudioFixture(t);
    // Official/wall time advances while the audio frame clock stops, without
    // AudioContext changing its running state. Fresh audio resumes afterwards.
    await f.advance(gapSeconds * 1000);
    await f.clockChanged();
    for (let sequence = 3; sequence <= 8; sequence++) {
      await f.advance(256);
      f.emitPcm(sequence, { contextTime: sequence * .256 });
      await f.clockChanged();
    }
    assert.equal(f.contexts.at(-1).state, 'running');
    const recovered = f.pcmChunks.slice(2);
    // Dropping the first block across the discontinuity is acceptable, but
    // subsequent blocks must resume and carry their actual programme times.
    assert.ok(recovered.length >= 2, 'fresh PCM must resume after clock recovery');
    const expected = 2200 + gapSeconds + 7 * .256;
    const actual = recovered.at(-1).start;
    assert.ok(Math.abs(actual - expected) < .001,
      `new PCM must use programme time ${expected}, received ${actual}`);
    assert.ok(recovered.every(chunk => chunk.start >= 2200 + gapSeconds + .512 - .001),
      'new audio must not be assigned to the pre-discontinuity timeline');
  });
}

test('late PCM messages do not shift the timeline when the running audio clock keeps advancing', async t => {
  const f = await primedAudioFixture(t);
  // This old block waited in the message queue; currentTime nevertheless
  // tracks wall time. Callback arrival is not the time its audio was sampled.
  await f.advance(11008);
  await f.clockChanged();
  f.emitPcm(3);
  // The bounded worklet mailbox drops intervening blocks, so the next fresh
  // block has a sequence jump. Its frame timestamp still matches wall time.
  await f.advance(256);
  f.emitPcm(46);
  await f.clockChanged();
  assert.equal(f.contexts.at(-1).state, 'running');
  const actual = f.pcmChunks.at(-1).start;
  const expected = 2200 + 45 * .256;
  assert.ok(Math.abs(actual - expected) < .001,
    `late delivery must not rebase fresh PCM away from ${expected}, received ${actual}`);
});
