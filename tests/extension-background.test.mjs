import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { validCaptureSnapshot } from '../src/capture-protocol.js';

// Run the real worker and its message listener; only browser APIs are replaced.
const worker = (await readFile(new URL('../extension/background.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '');
const extensionId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const extensionUrl = `chrome-extension://${extensionId}/`;
const programmeUrl = 'https://f1tv.formula1.com/detail/1000010360/qualifying?f1zh-replay=1';
const clock = { protocol: 1, client: 'extension', programmeId: '1000010360:vod-test', time: 2040, origin: 0,
  at: 1e12, epoch: 1, rate: 1, paused: false, muted: false, startProblem: null, problem: null,
  pageLabel: '回放模拟 · 采集页', audioLabel: 'Track FX' };

function fixture({ snapshot = clock, mediaStream } = {}) {
  const state = { token: 'test-pairing-token' };
  const calls = [];
  const listeners = {};
  const tabs = new Map([
    [1, { id: 1, active: true, title: 'Track FX', url: `${programmeUrl}&f1zh-capture=1` }],
    [2, { id: 2, active: false, title: 'English F1 Live', url: programmeUrl }],
  ]);
  let hasOffscreen = false;
  const event = key => ({ addListener(listener) { listeners[key] = listener; } });
  const record = (api, args) => calls.push({ api, args: structuredClone(args) });
  const chrome = {
    runtime: {
      id: extensionId, getURL: name => `${extensionUrl}${name}`, onMessage: event('message'),
      async getContexts() { return hasOffscreen ? [{}] : []; },
      async sendMessage(message) { record('offscreen', message); return { ok: true }; },
    },
    storage: { session: {
      async get(keys) {
        return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(state[key])]));
      },
      async set(values) { Object.assign(state, structuredClone(values)); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key]; },
    } },
    tabs: {
      async get(id) { if (!tabs.has(id)) throw Error('missing-tab'); return structuredClone(tabs.get(id)); },
      async query() { return [...tabs.values()].map(tab => structuredClone(tab)); },
      async update(id, changes) { record('tabs.update', { id, ...changes }); Object.assign(tabs.get(id), changes); },
      async sendMessage(id, message) {
        record('tabs.sendMessage', { id, message });
        return message.type === 'snapshot' ? structuredClone(snapshot) : undefined;
      },
      onRemoved: event('removed'), onUpdated: event('updated'),
    },
    offscreen: { async createDocument(options) { record('offscreen.createDocument', options); hasOffscreen = true; } },
    tabCapture: {
      async getMediaStreamId(options) { record('tabCapture.getMediaStreamId', options); return mediaStream ? mediaStream() : 'test-stream'; },
      onStatusChanged: event('capture-status'),
    },
    action: {
      async setBadgeText(value) { record('badge', value); },
      async setBadgeBackgroundColor() {}, async setTitle() {},
    },
  };
  vm.runInNewContext(worker, { chrome, URL, crypto: { randomUUID }, validCaptureSnapshot, installApiRouter() {}, publicSettings: async () => ({translation:{configured:true},asr:{configured:true,enabled:true}}) }, { filename: 'extension/background.js' });
  const popup = { id: extensionId, url: `${extensionUrl}popup.html` };
  const offscreen = { id: extensionId, url: `${extensionUrl}offscreen.html` };
  const page = id => ({ id: extensionId, tab: structuredClone(tabs.get(id)), frameId: 0, url: tabs.get(id).url });
  const send = (message, sender = popup) => new Promise(resolve => {
    const keepAlive = listeners.message({ to: 'background', ...message }, sender, result => resolve(structuredClone(result)));
    if (keepAlive !== true) resolve(undefined);
  });
  return { state, calls, send, page, popup, offscreen,
    streams: () => calls.filter(call => call.api === 'tabCapture.getMediaStreamId'),
    offscreenCalls: type => calls.filter(call => call.api === 'offscreen' && call.args.type === type),
    start: () => send({ type: 'start', tabId: 1 }) };
}

test('opening the panel is inactive and never requests audio or changes tab sound', async () => {
  const f = fixture();
  const panel = await f.send({ type: 'panel-state', tabId: 1 });
  assert.equal(panel.active, false);
  assert.equal(panel.busy, false);
  assert.equal(panel.configured, true);
  assert.equal(panel.asrConfigured, true);
  assert.equal(panel.supported, true);
  assert.equal(panel.problem, null);
  assert.equal(f.state.capture, undefined);
  assert.equal(f.streams().length, 0);
  assert.equal(f.calls.some(call => call.api === 'offscreen.createDocument' || call.api === 'tabs.update'), false);
});

test('only the popup sender can start, using the script-provided protocol and timeline', async () => {
  const f = fixture();
  for (const sender of [f.page(1), f.offscreen,
    { id: extensionId, url: `${extensionUrl}options.html` },
    { ...f.popup, id: 'different-extension' }]) {
    await f.send({ type: 'start', tabId: 1 }, sender);
  }
  assert.equal(f.streams().length, 0);
  assert.equal(f.state.capture, undefined);
  assert.deepEqual(await f.start(), { ok: true });
  assert.equal(f.state.capture.programmeId, clock.programmeId);
  assert.deepEqual(f.offscreenCalls('start')[0].args.snapshot, clock);
  assert.equal(f.streams().length, 1);
});

test('script readiness problems block audio before a session is allocated', async () => {
  const problem = '当前是观看页，请先打开采集页。';
  const f = fixture({ snapshot: { ...clock, startProblem: problem } });
  assert.equal((await f.send({ type: 'panel-state', tabId: 1 })).problem, problem);
  assert.deepEqual(await f.start(), { ok: false, message: problem });
  assert.equal(f.state.capture, undefined);
  assert.equal(f.streams().length, 0);
  assert.equal(f.offscreenCalls('start').length, 0);
});

test('old scripts and invalid official clocks cannot start capture', async () => {
  for (const snapshot of [{ ...clock, protocol: undefined }, { ...clock, time: NaN }, { ...clock, programmeId: '' }]) {
    const f = fixture({ snapshot });
    assert.equal((await f.start()).ok, false);
    assert.equal(f.state.capture, undefined);
    assert.equal(f.streams().length, 0);
  }
});

test('switching off releases the stream and restores sound without ever muting the tab', async () => {
  const f = fixture();
  assert.equal((await f.start()).ok, true);
  const captureId = f.state.capture.id;
  assert.deepEqual(await f.send({ type: 'stop' }), { ok: true });
  assert.equal(f.state.capture, undefined);
  assert.deepEqual(f.offscreenCalls('stop').map(call => call.args.id), [captureId]);
  const updates = f.calls.filter(call => call.api === 'tabs.update');
  assert.ok(updates.length >= 1);
  assert.ok(updates.every(call => call.args.id === 1 && call.args.muted === false));
  const stopIndex = f.calls.findIndex(call => call.api === 'offscreen' && call.args.type === 'stop');
  assert.ok(f.calls.slice(stopIndex + 1).some(call => call.api === 'tabs.update' && call.args.muted === false));
  assert.equal((await f.send({ type: 'panel-state', tabId: 1 })).active, false);
});

test('turning off viewer subtitles only relays viewer state and does not stop capture', async () => {
  const f = fixture();
  await f.start();
  const captureId = f.state.capture.id;
  const packet = { version: 1, type: 'viewer-status', programmeId: clock.programmeId,
    sender: 'test-viewer', viewerState: { enabled: false, paused: true, contentTime: 1990 } };
  await f.send({ type: 'relay', packet }, f.page(2));
  assert.equal(f.state.capture.id, captureId);
  assert.equal(f.offscreenCalls('stop').length, 0);
  assert.deepEqual(f.offscreenCalls('relay').at(-1).args.packet, packet);
});

test('offscreen failure clears its own session and restores audible playback', async () => {
  const f = fixture();
  await f.start();
  const captureId = f.state.capture.id;
  await f.send({ type: 'failed', id: 'stale-session', message: 'stale' }, f.offscreen);
  assert.equal(f.state.capture.id, captureId);
  await f.send({ type: 'failed', id: captureId, message: '音频连接已断开。' }, f.offscreen);
  assert.equal(f.state.capture, undefined);
  assert.equal(f.offscreenCalls('stop').length, 1);
  assert.equal(f.calls.filter(call => call.api === 'tabs.update').at(-1).args.muted, false);
  assert.equal(f.state['status:1'].state, 'error');
  assert.equal(f.state['status:1'].active, false);
});

test('repeated and concurrent starts cannot acquire a second stream', async () => {
  let release, entered;
  const entry = new Promise(resolve => { entered = resolve; });
  const stream = new Promise(resolve => { release = resolve; });
  const f = fixture({ mediaStream: () => { entered(); return stream; } });
  const first = f.start();
  await entry;
  assert.equal((await f.start()).ok, false);
  assert.equal(f.streams().length, 1);
  release('test-stream');
  assert.equal((await first).ok, true);
  const captureId = f.state.capture.id;
  assert.equal((await f.start()).ok, false);
  assert.equal(f.state.capture.id, captureId);
  assert.equal(f.streams().length, 1);
  assert.equal(f.offscreenCalls('start').length, 1);
  assert.equal(f.state['status:1'].active, true);
});

test('another F1 TV page cannot stop the capture, but the source page can', async () => {
  const f = fixture();
  await f.start();
  const captureId = f.state.capture.id;
  await f.send({ type: 'stop' }, f.page(2));
  assert.equal(f.state.capture.id, captureId);
  assert.equal(f.offscreenCalls('stop').length, 0);
  assert.deepEqual(await f.send({ type: 'stop' }, f.page(1)), { ok: true });
  assert.equal(f.state.capture, undefined);
  assert.equal(f.offscreenCalls('stop').length, 1);
});
