import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import http from 'node:http';
import { createSettingsStore } from '../lib/settings.mjs';
import { createServer } from '../server.mjs';
import { createTranslator } from '../lib/translator.mjs';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const original = 'TRANSLATION_MODE=api\nAPI_ENDPOINT=https://translate.example/chat\nAPI_MODEL=old-model\nAPI_KEY=translation-fixture-secret\nAPI_THINKING=disabled\nAPI_TIMEOUT_MS=9000\nASR_ENDPOINT=wss://speech.example/inference\nASR_MODEL=qwen-audio-3.1-asr-flash-streaming\nDASHSCOPE_API_KEY=speech-fixture-secret\nASR_TIMEOUT_MS=42000\nCUSTOM_SETTING="keep this # value"\n';
const changes = () => ({ translation: { key: '', endpoint: 'https://translate.example/chat', model: 'new-model', thinking: 'disabled' },
  asr: { key: '', enabled: false, endpoint: '', model: '' } });

async function fixture(t, content = original, options) {
  const root = await mkdtemp(join(tmpdir(), 'f1-settings-'));
  const envFile = join(root, '.env');
  if (content !== null) await writeFile(envFile, content);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, envFile, store: await createSettingsStore({ envFile }, options) };
}

test('configuration reads never expose either key or write the env file', async t => {
  const f = await fixture(t);
  const config = f.store.getConfig();
  assert.equal(config.translation.configured, true);
  assert.equal(config.asr.configured, true);
  assert.equal(config.asr.enabled, true);
  assert.equal(config.translation.keySaved, true);
  assert.equal(config.asr.keySaved, true);
  assert.doesNotMatch(JSON.stringify(config), /fixture-secret/);
  assert.equal(await readFile(f.envFile, 'utf8'), original);
  const blank = await fixture(t, null);
  assert.equal(blank.store.getConfig().translation.configured, false);
  await assert.rejects(readFile(blank.envFile), { code: 'ENOENT' });
});

test('a caption-only first install allows blank disabled ASR and requires a translation key', async t => {
  for (const content of [null, 'TRANSLATION_MODE=api\nAPI_KEY=\nASR_ENDPOINT=\nASR_MODEL=\nDASHSCOPE_API_KEY=\n']) {
    const f = await fixture(t, content), input = changes();
    assert.equal(f.store.getConfig().asr.endpoint, '');
    assert.throws(() => f.store.prepare(input), { code: 'TRANSLATION_KEY_REQUIRED' });
    input.translation.key = 'first-translation-fixture-key';
    await f.store.commit(f.store.prepare(input));
    const saved = parseEnv(await readFile(f.envFile, 'utf8'));
    assert.equal(saved.ASR_ENABLED, 'false');
    assert.equal(saved.ASR_ENDPOINT, '');
    assert.equal(saved.DASHSCOPE_API_KEY, '');
    assert.equal(f.store.getConfig().translation.configured, true);
    assert.equal(f.store.getRuntimeConfig().asr, null);
  }
});

test('save keeps independent blank keys, disabled ASR settings and unrelated env parameters', async t => {
  const f = await fixture(t, original + "CUSTOM_WINDOWS='C:\\new\\testing'\n");
  await f.store.commit(f.store.prepare(changes()));
  const saved = parseEnv(await readFile(f.envFile, 'utf8'));
  assert.equal(saved.API_KEY, 'translation-fixture-secret');
  assert.equal(saved.DASHSCOPE_API_KEY, 'speech-fixture-secret');
  assert.equal(saved.ASR_ENDPOINT, 'wss://speech.example/inference');
  assert.equal(saved.ASR_MODEL, 'qwen-audio-3.1-asr-flash-streaming');
  assert.equal(saved.ASR_ENABLED, 'false');
  assert.equal(saved.API_TIMEOUT_MS, '9000');
  assert.equal(saved.ASR_TIMEOUT_MS, '42000');
  assert.equal(saved.CUSTOM_SETTING, 'keep this # value');
  assert.equal(saved.CUSTOM_WINDOWS, 'C:\\new\\testing');
  assert.equal(f.store.getRuntimeConfig().asr, null);
  const update = changes(); update.translation.key = 'replacement-translation-secret'; update.asr.enabled = true;
  await f.store.commit(f.store.prepare(update));
  assert.equal(f.store.getRuntimeConfig().translation.key, update.translation.key);
  assert.equal(f.store.getRuntimeConfig().asr.apiKey, 'speech-fixture-secret');
});

test('invalid input, external edits and failed atomic writes leave the old state untouched', async t => {
  const f = await fixture(t);
  for (const field of ['key', 'endpoint', 'model', 'thinking']) {
    const input = changes(); input.translation[field] += '\nEVIL=1';
    assert.throws(() => f.store.prepare(input), { code: 'INVALID_CONFIG' });
  }
  const bad = changes(); bad.asr.key = 'x\r\nEVIL=1';
  assert.throws(() => f.store.prepare(bad), { code: 'INVALID_CONFIG' });
  const query = changes(); query.translation.endpoint += '?key=secret';
  assert.throws(() => f.store.prepare(query), { code: 'INVALID_CONFIG' });
  const candidate = f.store.prepare(changes());
  await writeFile(f.envFile, original + 'EXTERNAL=preserve\n');
  await assert.rejects(f.store.commit(candidate), { code: 'CONFIG_CHANGED' });
  assert.match(await readFile(f.envFile, 'utf8'), /EXTERNAL=preserve/);
  assert.equal(f.store.getConfig().translation.model, 'old-model');
  const failed = await fixture(t, original, { renameImpl: async () => { throw Error('private filesystem detail'); } });
  await assert.rejects(failed.store.commit(failed.store.prepare(changes())), { code: 'CONFIG_SAVE_FAILED' });
  assert.equal(await readFile(failed.envFile, 'utf8'), original);
  assert.equal(failed.store.getConfig().translation.model, 'old-model');
});

async function service(t, f, extra = {}) {
  await mkdir(join(f.root, 'app')); await writeFile(join(f.root, 'app/index.html'), '<title>settings home</title>');
  await mkdir(join(f.root, 'demo')); await writeFile(join(f.root, 'demo/index.html'), '<title>demo</title>');
  const server = createServer({ rootDir: f.root, settingsStore: f.store, translator: createTranslator({ mode: 'mock' }), ...extra });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Origin: base, 'Sec-Fetch-Site': 'same-origin' };
  const session = await (await fetch(base + '/api/session', { headers })).json();
  return { base, headers, session, post: input => fetch(base + '/api/config', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` }, body: JSON.stringify(input) }) };
}

test('configuration API is same-origin and authenticated, saves without changing pairing token', async t => {
  const f = await fixture(t), s = await service(t, f);
  assert.match(await (await fetch(s.base)).text(), /settings home/);
  assert.match(await (await fetch(s.base + '/demo/')).text(), /demo/);
  for (const path of ['/local/private.txt', '/docs/readme.md', '/.env', '/lib/settings.mjs']) assert.equal((await fetch(s.base + path)).status, 404);
  assert.equal((await fetch(s.base + '/api/config')).status, 403);
  const config = await (await fetch(s.base + '/api/config', { headers: s.headers })).json();
  assert.equal(config.projectRoot, f.root);
  assert.equal(config.restartRequired, false);
  assert.doesNotMatch(JSON.stringify(config), /fixture-secret/);
  for (const origin of ['https://evil.example', 'https://f1tv.formula1.com', 'chrome-extension://' + 'a'.repeat(32)]) {
    assert.equal((await fetch(s.base + '/api/config', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Authorization: `Bearer ${s.session.token}` }, body: JSON.stringify(changes()) })).status, 403);
  }
  assert.equal((await fetch(s.base + '/api/config', { method: 'POST', headers: { ...s.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(changes()) })).status, 401);
  const saved = await s.post(changes()); assert.equal(saved.status, 200);
  assert.doesNotMatch(await saved.text(), /fixture-secret/);
  const session = await (await fetch(s.base + '/api/session', { headers: s.headers })).json();
  assert.equal(session.token, s.session.token);
  assert.equal(session.mode, 'api'); assert.equal(session.asr, false);
  assert.equal((await (await fetch(s.base + '/api/health')).json()).version, version);
});

test('saving during active ASR is rejected without changing the env file', async t => {
  let finish, began;
  const started = new Promise(resolve => { began = resolve; });
  const asr = { transcribe: () => { began(); return new Promise(resolve => { finish = () => resolve({ cues: [], usage: {} }); }); } };
  const f = await fixture(t), s = await service(t, f, { asr });
  const request = fetch(s.base + '/api/asr', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.session.token}` }, body: '{}' });
  await started;
  const rejected = await s.post(changes());
  assert.equal(rejected.status, 409); assert.equal((await rejected.json()).error.code, 'CONFIG_BUSY');
  assert.equal(await readFile(f.envFile, 'utf8'), original);
  finish(); assert.equal((await request).status, 200);
  assert.equal((await s.post(changes())).status, 200);
});

test('saved translation credentials and model apply to the next request without restarting', async t => {
  let received;
  const upstream = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received = { authorization: req.headers.authorization, body: JSON.parse(body) };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '新的本地测试译文' } }] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }));
  const f = await fixture(t), s = await service(t, f), input = changes();
  input.translation.endpoint = `http://127.0.0.1:${upstream.address().port}/chat`;
  input.translation.key = 'new-fixture-translation-secret';
  assert.equal((await s.post(input)).status, 200);
  const response = await fetch(s.base + '/api/translate', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.session.token}` },
    body: JSON.stringify({ cue: { id: 'test-cue', text: 'Test speech', start: 0, end: 2 } }) });
  assert.deepEqual(await response.json(), { text: '新的本地测试译文' });
  assert.equal(received.authorization, 'Bearer new-fixture-translation-secret');
  assert.equal(received.body.model, 'new-model');
  const speech = changes(); speech.asr.enabled = true;
  assert.equal((await s.post(speech)).status, 200);
  assert.equal((await (await fetch(s.base + '/api/health')).json()).asr, true);
});

test('radio sessions block saves between requests until explicitly cancelled', async t => {
  const radio = { handle: async input => input.action === 'open' ? { sessionId: 'fixture-session', cues: [] } : { cues: [], ended: true }, dispose() {} };
  const f = await fixture(t), s = await service(t, f, { radio });
  const request = action => fetch(s.base + '/api/radio', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.session.token}` }, body: JSON.stringify({ action }) });
  assert.equal((await request('open')).status, 200);
  assert.equal((await s.post(changes())).status, 409);
  assert.equal((await request('cancel')).status, 200);
  assert.equal((await s.post(changes())).status, 200);
});
