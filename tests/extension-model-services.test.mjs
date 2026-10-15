import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelServices } from '../extension/model-services.js';
import { promptForCue } from '../lib/translation-prompt.mjs';

const input = { cue: { id: 'fx:1', text: 'Box now.', start: 1, end: 2 }, context: [] };
const settings = { translation: { mode: 'api', endpoint: 'https://translate.example/chat', model: 'deepseek-flash',
  key: 'translation-fixture-secret', thinking: 'disabled', timeoutMs: 1000 }, asr: { enabled: false } };
const chromeApi = { permissions: { async contains() { return true; } } };
const response = () => new Response(JSON.stringify({ choices: [{ message: { content: '立即进站。' } }] }), { status: 200 });

test('browser direct translation reuses existing prompt and supports native response streams without Node Buffer', async () => {
  let request;
  const services = createModelServices({ chromeApi, loadSettingsImpl: async () => settings,
    fetchImpl: async (url, options) => { request = { url, options }; return response(); } });
  assert.deepEqual(await services.translateDirect(input), { text: '立即进站。' });
  const body = JSON.parse(request.options.body);
  assert.equal(body.messages[0].content, promptForCue(input.cue));
  assert.equal(body.model, settings.translation.model); assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(request.options.headers.Authorization, `Bearer ${settings.translation.key}`);
  assert.equal(request.options.redirect, 'error'); assert.equal(request.options.credentials, 'omit');
});

test('translation has a strict four-request bound and releases slots after errors', async () => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const services = createModelServices({ chromeApi, loadSettingsImpl: async () => settings,
    fetchImpl: async () => { await barrier; return response(); } });
  const pending = Array.from({ length: 4 }, () => services.translateDirect(input));
  await assert.rejects(services.translateDirect(input), { code: 'TRANSLATION_BUSY' });
  release(); await Promise.all(pending);
  await assert.rejects(services.translateDirect({}), { code: 'INVALID_CUE' });
  assert.deepEqual(await services.translateDirect(input), { text: '立即进站。' });
});

test('revoked permissions block calls; disabled ASR never connects', async () => {
  let requests = 0;
  const services = createModelServices({ chromeApi: { permissions: { async contains() { return false; } } },
    loadSettingsImpl: async () => settings, fetchImpl: async () => { requests++; return response(); } });
  await assert.rejects(services.translateDirect(input), { code: 'HOST_PERMISSION_REQUIRED' });
  await assert.rejects(services.transcribeDirect({}), { code: 'ASR_NOT_CONFIGURED' });
  assert.equal(requests, 0);
});

test('bounded provider responses and private network errors expose only safe codes', async () => {
  for (const fetchImpl of [async () => new Response('x'.repeat(65537)),
    async () => { throw Error(`Unable to reach ${settings.translation.endpoint} with ${settings.translation.key}`); }]) {
    const services = createModelServices({ chromeApi, loadSettingsImpl: async () => settings, fetchImpl });
    await assert.rejects(services.translateDirect(input), error => {
      assert.ok(['INVALID_UPSTREAM_RESPONSE', 'UPSTREAM_UNAVAILABLE'].includes(error.code));
      assert.doesNotMatch(error.message + JSON.stringify(error), /fixture-secret|translate\.example/); return true;
    });
  }
});

test('direct translation cancellation aborts provider fetch', async () => {
  let upstreamSignal;
  const services = createModelServices({ chromeApi, loadSettingsImpl: async () => settings,
    fetchImpl: async (_endpoint, options) => { upstreamSignal = options.signal; return new Promise(() => {}); } });
  const controller = new AbortController(), task = services.translateDirect(input, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(task, { code: 'CANCELLED' }); assert.equal(upstreamSignal.aborted, true);
});

test('ASR startup cleanup finishes once before any new request installs authorization', async () => {
  const staleId = 1900000001, rules = new Map([[staleId, { id: staleId }]]), operations = [];
  const api = { ...chromeApi, runtime: { id: 'a'.repeat(32) }, declarativeNetRequest: {
    async getSessionRules() { operations.push('read'); return [...rules.values()]; },
    async updateSessionRules(update) {
      if (update.removeRuleIds) operations.push(update.removeRuleIds.includes(staleId) ? 'remove-stale' : 'remove-active');
      for (const id of update.removeRuleIds ?? []) rules.delete(id);
      for (const rule of update.addRules ?? []) { operations.push('install'); rules.set(rule.id, rule); }
    },
  } };
  const services = createModelServices({ chromeApi: api,
    loadSettingsImpl: async () => ({ ...settings, asr: { enabled: true, endpoint: 'wss://speech.example/inference',
      model: 'qwen-audio-3.1-asr-flash-streaming', apiKey: 'speech-fixture-secret' } }),
    WebSocketImpl: class { constructor() { operations.push('connect'); throw Error('fixture connection failure'); } },
  });
  const audio = { sampleRate: 16000, start: 0, audioBase64: 'AAA=' };
  for (let index = 0; index < 2; index++) await assert.rejects(services.transcribeDirect(audio), { code: 'ASR_UPSTREAM_FAILED' });
  assert.deepEqual(operations, ['read', 'remove-stale', 'read', 'install', 'connect', 'remove-active', 'read', 'install', 'connect', 'remove-active']);
  assert.equal(rules.size, 0);
});

test('failed startup cleanup is reported before connecting and can be retried', async () => {
  let reads = 0, connections = 0;
  const api = { ...chromeApi, runtime: { id: 'a'.repeat(32) }, declarativeNetRequest: {
    async getSessionRules() { if (++reads === 1) throw Error('private Chrome detail'); return []; },
    async updateSessionRules() {},
  } };
  const services = createModelServices({ chromeApi: api,
    loadSettingsImpl: async () => ({ ...settings, asr: { enabled: true, endpoint: 'wss://speech.example/inference',
      model: 'qwen-audio-3.1-asr-flash-streaming', apiKey: 'speech-fixture-secret' } }),
    WebSocketImpl: class { constructor() { connections++; throw Error('fixture connection failure'); } },
  });
  const audio = { sampleRate: 16000, start: 0, audioBase64: 'AAA=' };
  await assert.rejects(services.transcribeDirect(audio), { code: 'ASR_AUTH_CLEANUP_FAILED', message: 'ASR_AUTH_CLEANUP_FAILED' });
  assert.equal(connections, 0);
  await assert.rejects(services.transcribeDirect(audio), { code: 'ASR_UPSTREAM_FAILED' });
  assert.equal(connections, 1);
});
