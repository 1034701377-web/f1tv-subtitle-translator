import test from 'node:test';
import assert from 'node:assert/strict';
import { DocumentWebSocket } from '../extension/document-websocket.js';
import { installWebSocketHost } from '../extension/websocket-host.js';
import { createBrowserAsr } from '../extension/browser-asr.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const id = 'a'.repeat(32), backgroundUrl = `chrome-extension://${id}/background.js`;
const config = { endpoint: 'wss://speech.example/inference', apiKey: 'never-cross-the-port-secret',
  model: 'qwen-audio-3.1-asr-flash-streaming', timeoutMs: 1000 };
const input = { sampleRate: 16000, start: 2040, audioBase64: Buffer.alloc(32000).toString('base64') };

function eventHub() {
  const listeners = new Set();
  return { addListener: value => listeners.add(value), removeListener: value => listeners.delete(value),
    fire(...values) { for (const listener of [...listeners]) listener(...values); } };
}

function fixture(t, { sender = { id, url: backgroundUrl }, autoOpen = true, protocol = false, holdBinary = false } = {}) {
  const sockets = [], connections = [], wire = [], rules = new Map();
  const hostChrome = { runtime: { id, onConnect: eventHub(), getURL: file => `chrome-extension://${id}/${file}` } };
  const workerChrome = { runtime: { id, connect({ name }) {
    let connected = true;
    const worker = { name, onMessage: eventHub(), onDisconnect: eventHub() };
    const host = { name, sender, onMessage: eventHub(), onDisconnect: eventHub() };
    worker.postMessage = message => {
      if (!connected) throw Error('disconnected');
      const copy = JSON.parse(JSON.stringify(message)); wire.push(copy);
      queueMicrotask(() => { if (connected) host.onMessage.fire(copy); });
    };
    host.postMessage = message => {
      if (!connected) throw Error('disconnected');
      const copy = JSON.parse(JSON.stringify(message)); wire.push(copy);
      queueMicrotask(() => { if (connected) worker.onMessage.fire(copy); });
    };
    worker.disconnect = () => {
      if (!connected) return;
      connected = false; queueMicrotask(() => host.onDisconnect.fire());
    };
    host.disconnect = () => {
      if (!connected) return;
      connected = false; queueMicrotask(() => worker.onDisconnect.fire());
    };
    connections.push({ worker, host, isConnected: () => connected });
    queueMicrotask(() => hostChrome.runtime.onConnect.fire(host));
    return worker;
  } }, permissions: { async contains() { return true; } }, declarativeNetRequest: {
    async getSessionRules() { return [...rules.values()]; },
    async updateSessionRules({ addRules = [], removeRuleIds = [] }) {
      for (const rule of addRules) rules.set(rule.id, rule);
      for (const ruleId of removeRuleIds) rules.delete(ruleId);
    },
  } };
  class NativeSocket extends EventTarget {
    constructor(endpoint) {
      super(); this.url = endpoint; this.readyState = 0; this.bufferedAmount = 0; this.frames = [];
      sockets.push(this);
      if (autoOpen) queueMicrotask(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1; this.dispatchEvent(new Event('open'));
      });
    }
    send(data) {
      assert.equal(this.readyState, 1); this.frames.push(data);
      if (data instanceof Blob && holdBinary) this.bufferedAmount += data.size;
      if (protocol && typeof data === 'string') {
        const command = JSON.parse(data); this.taskId = command.header.task_id;
        if (command.header.action === 'run-task') queueMicrotask(() => this.providerEvent('task-started'));
        if (command.header.action === 'finish-task') queueMicrotask(() => {
          this.providerEvent('result-generated', { output: { sentence: {
            sentence_id: 1, text: 'Box now.', begin_time: 100, end_time: 700, sentence_end: true,
          } } });
          this.providerEvent('task-finished');
        });
      }
    }
    providerEvent(event, payload = {}) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ header: { event, task_id: this.taskId }, payload }) }));
    }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.closed = true; this.dispatchEvent(new Event('close')); }
  }
  const removeHost = installWebSocketHost({ chromeApi: hostChrome, WebSocketImpl: NativeSocket, drainIntervalMs: 5 });
  t.after(removeHost);
  class ProxySocket extends DocumentWebSocket { constructor(url) { super(url, { chromeApi: workerChrome }); } }
  return { workerChrome, hostChrome, sockets, connections, wire, rules, WebSocketImpl: ProxySocket };
}

test('document transport round-trips text/PCM and runs existing ASR protocol without transferring keys', async t => {
  const f = fixture(t, { protocol: true }), received = [];
  const result = await createBrowserAsr(config, { chromeApi: f.workerChrome, WebSocketImpl: f.WebSocketImpl }).transcribe(input,
    { onCue: cue => received.push(cue) });
  assert.deepEqual(result.cues, [{ text: 'Box now.', start: 2040.1, end: 2040.7 }]);
  assert.deepEqual(result.cues, received);
  const binary = f.sockets[0].frames.filter(frame => frame instanceof Blob);
  assert.equal(binary.length, 10); assert.ok(binary.every(frame => frame.size === 3200));
  assert.deepEqual(Buffer.concat(await Promise.all(binary.map(async blob => Buffer.from(await blob.arrayBuffer())))), Buffer.from(input.audioBase64, 'base64'));
  assert.doesNotMatch(JSON.stringify(f.wire), /never-cross-the-port-secret|apiKey|Authorization/);
  assert.equal(f.rules.size, 0); await tick(); assert.equal(f.sockets[0].closed, true);
});

test('ACK and periodic drain account for pending IPC bytes and real socket backpressure', async t => {
  const f = fixture(t, { holdBinary: true }), socket = new f.WebSocketImpl(config.endpoint);
  await tick(); assert.equal(socket.readyState, 1);
  for (let i = 0; i < 20; i++) socket.send(new Uint8Array(3200));
  assert.equal(socket.bufferedAmount, 64000);
  assert.throws(() => socket.send(new Uint8Array(3200)), /WEBSOCKET_BACKPRESSURE/);
  await tick(); assert.equal(socket.bufferedAmount, 64000); assert.equal(f.sockets[0].bufferedAmount, 64000);
  f.sockets[0].bufferedAmount = 0;
  await delay(15); assert.equal(socket.bufferedAmount, 0);
  socket.send('finish'); await tick(); assert.equal(socket.bufferedAmount, 0);
  socket.close(); await tick(); assert.equal(f.sockets[0].closed, true);
  const next = new f.WebSocketImpl(config.endpoint); await tick(); assert.equal(next.readyState, 1); next.close();
});

test('cancel during handshake or buffered sending closes document socket and removes DNR', async t => {
  for (const options of [{ autoOpen: false }, { holdBinary: true, protocol: true }]) {
    const f = fixture(t, options), controller = new AbortController();
    const task = createBrowserAsr(config, { chromeApi: f.workerChrome, WebSocketImpl: f.WebSocketImpl }).transcribe(
      { ...input, audioBase64: Buffer.alloc(96000).toString('base64') }, { signal: controller.signal });
    await tick(); controller.abort();
    await assert.rejects(task, { code: 'CANCELLED' }); await tick();
    assert.equal(f.sockets[0].closed, true); assert.equal(f.rules.size, 0);
  }
});

test('document disconnect fails promptly and releases authorization', async t => {
  const f = fixture(t, { autoOpen: false });
  const task = createBrowserAsr(config, { chromeApi: f.workerChrome, WebSocketImpl: f.WebSocketImpl }).transcribe(input);
  await tick(); f.connections[0].host.disconnect();
  await assert.rejects(task, { code: 'ASR_UPSTREAM_FAILED' });
  assert.equal(f.rules.size, 0);
});

test('host rejects tabs and non-background callers while leaving unrelated ports untouched', async t => {
  for (const sender of [{ id, url: backgroundUrl, tab: { id: 1 } }, { id, url: `chrome-extension://${id}/options.html` },
    { id: 'b'.repeat(32), url: backgroundUrl }]) {
    const f = fixture(t, { sender }), socket = new f.WebSocketImpl(config.endpoint);
    let errors = 0; socket.addEventListener('error', () => errors++);
    await tick(); assert.equal(socket.readyState, 3); assert.equal(errors, 1); assert.equal(f.sockets.length, 0);
  }
  const f = fixture(t);
  f.workerChrome.runtime.connect({ name: 'f1zh-api' }); await tick();
  assert.equal(f.connections[0].isConnected(), true); assert.equal(f.sockets.length, 0);
});

test('invalid endpoint and oversized/binary provider responses cannot bypass worker validation', async t => {
  const unsafe = fixture(t), bad = new unsafe.WebSocketImpl('wss://speech.example/?secret=1');
  await tick(); assert.equal(bad.readyState, 3); assert.equal(unsafe.sockets.length, 0);
  for (const data of [new Uint8Array([1]), 'x'.repeat(65537)]) {
    const f = fixture(t, { protocol: false });
    const task = createBrowserAsr(config, { chromeApi: f.workerChrome, WebSocketImpl: f.WebSocketImpl }).transcribe(input);
    await tick(); f.sockets[0].dispatchEvent(new MessageEvent('message', { data }));
    await assert.rejects(task, { code: 'ASR_INVALID_RESPONSE' });
    assert.equal(f.rules.size, 0);
  }
});
