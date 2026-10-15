import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsStore, permissionOrigin } from '../extension/settings-store.js';

function fixture({ allowed = true } = {}) {
  const data = {}, calls = [];
  const chromeApi = {
    storage: { local: {
      async setAccessLevel(value) { calls.push(['access', value]); },
      async get(key) { calls.push(['get', key]); return structuredClone(data); },
      async set(value) { calls.push(['set']); Object.assign(data, structuredClone(value)); },
      async remove(key) { delete data[key]; },
    } },
    permissions: { async contains(value) { calls.push(['permission', value]); return allowed; } },
  };
  return { data, calls, chromeApi, store: createSettingsStore({ chromeApi }) };
}
const input = () => ({
  translation: { key: 'translation-fixture-secret', endpoint: 'https://translate.example/chat', model: 'deepseek-flash', thinking: 'disabled' },
  asr: { enabled: true, key: 'speech-fixture-secret', endpoint: 'wss://speech.example/inference', model: 'qwen-audio-3.1-asr-flash-streaming' },
});

test('fresh extension is unconfigured, ASR disabled, and storage is restricted before reading', async () => {
  const f = fixture();
  const config = await f.store.publicSettings();
  assert.equal(config.translation.configured, false);
  assert.equal(config.translation.model, 'deepseek-flash');
  assert.equal(config.asr.configured, false);
  assert.equal(config.asr.enabled, false);
  assert.equal(config.asr.endpoint, '');
  assert.deepEqual(f.calls[0], ['access', { accessLevel: 'TRUSTED_CONTEXTS' }]);
  assert.deepEqual(f.data, {});
  const request = input(); request.translation.key = ''; request.asr.enabled = false;
  await assert.rejects(f.store.saveSettings(request), { code: 'TRANSLATION_KEY_REQUIRED' });
  assert.deepEqual(f.data, {});
});

test('public config never contains keys; blank keys preserve independent saved values', async () => {
  const f = fixture();
  const saved = await f.store.saveSettings(input());
  assert.equal(saved.translation.keySaved, true); assert.equal(saved.asr.keySaved, true);
  assert.doesNotMatch(JSON.stringify(saved), /fixture-secret|apiKey/);
  const update = input(); update.translation.key = ' '; update.asr.key = ''; update.asr.enabled = false;
  update.asr.endpoint = ''; update.asr.model = ''; update.translation.model = 'changed-model';
  await f.store.saveSettings(update);
  const privateSettings = await f.store.loadSettings();
  assert.equal(privateSettings.translation.key, input().translation.key);
  assert.equal(privateSettings.asr.apiKey, input().asr.key);
  assert.equal(privateSettings.translation.model, 'changed-model');
  assert.equal(privateSettings.asr.endpoint, input().asr.endpoint);
  assert.equal(privateSettings.asr.enabled, false);
  assert.equal((await f.store.publicSettings()).asr.configured, false);
  assert.doesNotMatch(JSON.stringify(await f.store.publicSettings()), /fixture-secret/);
  assert.deepEqual(f.calls.filter(([type]) => type === 'permission')[1][1], { origins: ['wss://speech.example/*'] });
  assert.equal(f.calls.filter(([type]) => type === 'access').length, 1);
  await f.store.clearSettings();
  assert.equal((await f.store.publicSettings()).translation.keySaved, false);
});

test('caption-only save needs no ASR key, while enabling ASR does', async () => {
  const f = fixture(), request = input();
  request.asr = { enabled: false, key: '', endpoint: '', model: '' };
  await f.store.saveSettings(request);
  assert.equal((await f.store.publicSettings()).translation.configured, true);
  request.asr.enabled = true; request.asr.endpoint = input().asr.endpoint;
  await assert.rejects(f.store.saveSettings(request), { code: 'ASR_KEY_REQUIRED' });
});

test('unsafe endpoints, keys and models fail before persistence with safe error codes', async () => {
  const f = fixture();
  for (const endpoint of ['http://localhost/chat', 'http://example.com/chat', 'https://user:pass@example.com/',
    'https://example.com/?token=fixture-secret', 'https://example.com/#secret', 'https://example.com/*', 'https://example.com/^', 'not-a-url']) {
    const request = input(); request.translation.endpoint = endpoint;
    await assert.rejects(f.store.saveSettings(request), { code: 'INVALID_CONFIG', message: 'INVALID_CONFIG' });
  }
  for (const endpoint of ['ws://speech.example/', 'https://speech.example/', 'wss://user:pass@speech.example/',
    'wss://speech.example/?key=fixture-secret', 'wss://speech.example/#key', 'wss://speech.example/a|b']) {
    const request = input(); request.asr.endpoint = endpoint;
    await assert.rejects(f.store.saveSettings(request), { code: 'INVALID_CONFIG' });
  }
  for (const key of ['secret\r\nAuthorization: injected', 'x'.repeat(1025), 'private key']) {
    const request = input(); request.translation.key = key;
    await assert.rejects(f.store.saveSettings(request), { code: 'INVALID_CONFIG' });
  }
  assert.deepEqual(f.data, {});
});

test('missing target permission blocks save and public configs project only safe fields', async () => {
  const denied = fixture({ allowed: false });
  await assert.rejects(denied.store.saveSettings(input()), { code: 'HOST_PERMISSION_REQUIRED' });
  assert.deepEqual(denied.data, {});
  const f = fixture(), request = input();
  request.translation.prompt = 'Injected private prompt'; request.asr.debug = true;
  await f.store.saveSettings(request);
  assert.doesNotMatch(JSON.stringify(f.data), /prompt|debug|Injected/);
  assert.equal(permissionOrigin('wss://speech.example:8443/inference'), 'wss://speech.example:8443/*');
  f.data.providerSettings.translation.endpoint = 'https://user:fixture-secret@bad.example/';
  await assert.rejects(f.store.publicSettings(), { code: 'INVALID_CONFIG', message: 'INVALID_CONFIG' });
});

test('a failed trusted-storage restriction prevents any secret read or write', async () => {
  const f = fixture();
  f.chromeApi.storage.local.setAccessLevel = async () => { throw Error('private transport details'); };
  await assert.rejects(f.store.loadSettings(), { code: 'CONFIG_STORAGE_FAILED', message: 'CONFIG_STORAGE_FAILED' });
  assert.deepEqual(f.calls, []);
});
