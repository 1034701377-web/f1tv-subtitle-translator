import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { capturePageInfo } from '../src/capture-mode.js';

const origin = 'https://f1tv.formula1.com';
const programmeUrl = `${origin}/detail/1000010360/qualifying?f1zh-replay=1&f1zh-capture=1`;
const [pageBridge, contentBridge, userscript] = await Promise.all([
  readFile(new URL('../src/extension-bridge.js', import.meta.url), 'utf8'),
  readFile(new URL('../extension/bridge.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/page-entry.js', import.meta.url), 'utf8'),
]);
// Execute the actual snapshot/response wiring without instantiating the whole
// console/player UI. These boundaries select source; they do not assert its text.
const listenerStart = userscript.indexOf('listenExtensionMessages(message => {');
const hello = "postExtensionMessage({ type: 'hello' });";
const listenerEnd = userscript.indexOf(hello, listenerStart) + hello.length;
const snapshotStart = userscript.indexOf('async function collectorSnapshot() {');
if (snapshotStart < 0 || listenerStart <= snapshotStart || listenerEnd <= listenerStart) throw Error('Userscript bridge boundaries changed');
const realListener = userscript.slice(listenerStart, listenerEnd);
const realSnapshot = userscript.slice(snapshotStart, listenerStart);
const clock = { protocol: 1, collector: true, programmeId: '1000010360:vod-test', time: 2040,
  origin: 0, at: 1e12, epoch: 1, rate: 1, paused: true, muted: false, startProblem: '请先播放 Track FX。', problem: null };
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture({ granted = true, sendBackground } = {}) {
  const listeners = new Set(), messages = [], timers = new Map();
  let timerId = 0, messageListener, requestId = 0;
  const page = {
    addEventListener(type, listener) { if (type === 'message') listeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'message') listeners.delete(listener); },
    postMessage(data, target) {
      assert.equal(this, page);
      assert.equal(target, origin);
      const cloned = structuredClone(data);
      messages.push(cloned);
      queueMicrotask(() => emit({ source: page, origin, data: cloned }));
    },
  };
  const sandbox = granted ? {
    postMessage() { throw Error('Used sandbox postMessage'); },
    addEventListener() { throw Error('Registered on sandbox window'); },
    removeEventListener() { throw Error('Removed from sandbox window'); },
  } : page;
  const emit = event => { for (const listener of [...listeners]) listener(event); };
  const scriptContext = vm.createContext({ window: sandbox, ...(granted ? { unsafeWindow: page } : {}),
    bootstrap:{version:'0.10.0'}, providerHealth:{}, collectorMode: true, enabled: false, status: { textContent: '初始提示' }, radioStatus: { textContent: '' },
    extensionBridgeIssue: null, refreshControls() {},
    collectorSnapshot: async () => structuredClone(clock),
  });
  vm.runInContext(`${pageBridge.replace(/^export /gm, '')}\n` +
    'globalThis.api = { postExtensionMessage, listenExtensionMessages, extensionSnapshotFailure };', scriptContext);
  const extensionId = 'test-extension';
  const chrome = { runtime: {
    id: extensionId,
    onMessage: { addListener(listener) { messageListener = listener; } },
    sendMessage(message) { if (sendBackground) return sendBackground(message); throw Error('Unexpected background action'); },
  } };
  const installContent = () => vm.runInNewContext(contentBridge.replace(/^import .*;\r?\n/gm, ''), {
    window: page, chrome, crypto: { randomUUID: () => `request-${++requestId}` },
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  const installScript = () => vm.runInContext(realListener, scriptContext);
  const requestSnapshot = () => new Promise(resolve => {
    assert.equal(messageListener({ type: 'snapshot' }, { id: extensionId }, value => resolve(structuredClone(value))), true);
  });
  return { page, sandbox, listeners, messages, timers, scriptContext, api: scriptContext.api, emit, runtime: chrome.runtime,
    deliverRuntime: message => messageListener(message, { id: extensionId }, () => { throw Error('Unexpected response'); }),
    installContent, installScript, requestSnapshot };
}

test('late userscript handshake crosses the granted sandbox through the page window', async () => {
  const f = fixture();
  assert.notEqual(f.sandbox, f.page);
  f.installContent();
  await flush(); // The content script's initial installed message was missed.
  f.installScript();
  await flush();
  assert.match(f.scriptContext.status.textContent, /扩展已连接/);
  assert.ok(f.messages.some(message => message.f1zhPage === 1 && message.type === 'hello'));
  assert.equal(f.messages.filter(message => message.f1zhExtension === 1 && message.type === 'installed').length, 2);
});

test('real content and userscript listeners round-trip a correlated snapshot across worlds', async () => {
  const f = fixture();
  f.installContent();
  f.installScript();
  assert.deepEqual(await f.requestSnapshot(), clock);
  const request = f.messages.find(message => message.type === 'snapshot-request');
  const response = f.messages.find(message => message.type === 'snapshot');
  assert.equal(response.requestId, request.requestId);
  assert.equal(response.f1zhPage, 1);
  assert.equal(f.timers.size, 0);
});

test('origin, iframe source and marker checks remain strict, and unsubscribe removes the page listener', () => {
  const f = fixture(), received = [];
  const close = f.api.listenExtensionMessages(message => received.push(message.type));
  const good = { source: f.page, origin, data: { f1zhExtension: 1, type: 'installed' } };
  f.emit({ ...good, origin: 'https://example.com' });
  f.emit({ ...good, source: { name: 'same-origin-iframe' } });
  f.emit({ ...good, data: { f1zhPage: 1, type: 'installed' } });
  f.emit({ ...good, data: { f1zhExtension: '1', type: 'installed' } });
  assert.deepEqual(received, []);
  f.emit(good);
  f.emit({ ...good, source: f.sandbox });
  assert.deepEqual(received, ['installed', 'installed']);
  assert.equal(f.listeners.size, 1);
  close();
  assert.equal(f.listeners.size, 0);
  f.emit(good);
  assert.equal(received.length, 2);
});

test('the ungranted window fallback still supports handshake and snapshot responses', async () => {
  const f = fixture({ granted: false });
  assert.equal(f.sandbox, f.page);
  f.installContent();
  f.installScript();
  assert.deepEqual(await f.requestSnapshot(), clock);
  assert.match(f.scriptContext.status.textContent, /扩展已连接/);
  assert.equal(f.timers.size, 0);
});

test('a rejected real SDK read uses the actual failure handler and preserves protocol without leaking the exception', async () => {
  const f = fixture();
  let reads = 0;
  const view = {
    currentContentTime: { eventType: 'vod' },
    querySelector() { return {}; },
    get associatedPlayer() { reads++; return Promise.reject(Error('private SDK detail https://media.invalid/private-token')); },
  };
  Object.assign(f.scriptContext, { pageWindow: { document: { querySelector: () => view } },
    location: { href: programmeUrl }, replaySimulation: true, capturePageInfo });
  // This is collectorSnapshot from page-entry.js, not a hand-copied
  // failure response. Its rejection must flow through the real registered handler.
  vm.runInContext(realSnapshot, f.scriptContext);
  f.installContent();
  f.installScript();
  const response = await f.requestSnapshot();
  assert.equal(reads, 1);
  assert.equal(response.protocol, 1);
  assert.equal(response.collector, true);
  assert.equal(response.pageLabel, '采集页');
  assert.equal(response.problem, null);
  assert.match(response.startProblem, /网页已连接.*未能读取官网播放器状态/);
  assert.doesNotMatch(JSON.stringify(response), /private|media\.invalid|token/);
  assert.equal(f.timers.size, 0);
});

const relayHello = { type: 'relay', packet: { version: 1, type: 'hello', programmeId: '1000010360:vod-test', sender: 'test-viewer' } };
const privateDetails = 'secret-pairing-token https://media.invalid/private-stream';

test('a missing runtime never announces installed, including after repeated page hellos', async () => {
  const f = fixture();
  f.runtime.id = undefined;
  f.installContent();
  f.api.postExtensionMessage({ type: 'hello' });
  f.api.postExtensionMessage({ type: 'hello' });
  await flush();
  assert.equal(f.messages.filter(message => message.type === 'installed').length, 0);
  const notices = f.messages.filter(message => message.type === 'bridge-unavailable');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].reason, 'context-invalidated');
  assert.equal(f.deliverRuntime({ type: 'snapshot' }), undefined);
  assert.equal(f.timers.size, 0);
});

test('synchronous and asynchronous context invalidation notify once without leaking details or forwarding again', async () => {
  for (const asynchronous of [false, true]) {
    let forwards = 0;
    const f = fixture({ sendBackground: () => {
      forwards++;
      const error = Error(`Extension context invalidated. ${privateDetails}`);
      if (asynchronous) return Promise.reject(error);
      throw error;
    } });
    f.installContent();
    await flush();
    const installedBefore = f.messages.filter(message => message.type === 'installed').length;
    f.api.postExtensionMessage(relayHello);
    await flush();
    const notices = f.messages.filter(message => message.type === 'bridge-unavailable');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].reason, 'context-invalidated');
    assert.equal(notices[0].message, '扩展已重新加载，请刷新本页以恢复连接。');
    assert.equal(JSON.stringify(notices).includes(privateDetails), false);
    f.api.postExtensionMessage({ type: 'hello' });
    f.api.postExtensionMessage(relayHello);
    await flush();
    assert.equal(forwards, 1);
    assert.equal(f.messages.filter(message => message.type === 'installed').length, installedBefore);
    assert.equal(f.messages.filter(message => message.type === 'bridge-unavailable').length, 1);
    assert.equal(f.deliverRuntime({ type: 'snapshot' }), undefined);
    assert.equal(f.timers.size, 0);
  }
});

test('successful forwarding clears a temporary issue in the real userscript and announces recovery only once', async () => {
  let forwards = 0;
  const f = fixture({ sendBackground: () => {
    if (++forwards === 1) return Promise.reject(Error(privateDetails));
    return Promise.resolve(null);
  } });
  f.installContent();
  f.installScript();
  await flush();
  f.api.postExtensionMessage(relayHello);
  await flush();
  const notice = f.messages.find(message => message.type === 'bridge-unavailable');
  assert.equal(notice.reason, 'transport-error');
  assert.equal(JSON.stringify(notice).includes(privateDetails), false);
  assert.ok(f.scriptContext.extensionBridgeIssue);
  const installedBefore = f.messages.filter(message => message.type === 'installed').length;
  f.api.postExtensionMessage(relayHello);
  await flush();
  assert.equal(forwards, 2);
  assert.equal(f.scriptContext.extensionBridgeIssue, null);
  assert.equal(f.messages.filter(message => message.type === 'installed').length, installedBefore + 1);
  f.api.postExtensionMessage(relayHello);
  await flush();
  assert.equal(forwards, 3);
  assert.equal(f.messages.filter(message => message.type === 'installed').length, installedBefore + 1);
});

test('a late successful send cannot announce recovery after the context is invalidated', async () => {
  let forwards = 0, finishPending;
  const pending = new Promise(resolve => { finishPending = resolve; });
  const f = fixture({ sendBackground: () => {
    forwards++;
    if (forwards === 1) return Promise.reject(Error('temporary transport failure'));
    if (forwards === 2) return pending;
    return Promise.reject(Error('Extension context invalidated.'));
  } });
  f.installContent();
  f.api.postExtensionMessage(relayHello);
  await flush();
  const installedBefore = f.messages.filter(message => message.type === 'installed').length;
  f.api.postExtensionMessage(relayHello);
  f.api.postExtensionMessage(relayHello);
  await flush();
  assert.equal(f.messages.filter(message => message.type === 'bridge-unavailable').at(-1).reason, 'context-invalidated');
  finishPending(null);
  await flush();
  assert.equal(f.messages.filter(message => message.type === 'installed').length, installedBefore);
  f.api.postExtensionMessage(relayHello);
  await flush();
  assert.equal(forwards, 3);
});
