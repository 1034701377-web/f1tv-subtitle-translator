import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.mjs';
import { createRadioService } from '../lib/radio-service.mjs';
import { createRadioClient } from '../src/radio-client.js';
import { AsrError } from '../lib/qwen-asr.mjs';

const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(predicate) {
  for (let count = 0; count < 200; count++) { if (predicate()) return; await tick(); }
  assert.fail('Expected bounded asynchronous operation to complete');
}

function upstreamFixture() {
  const calls = { open: 0, append: 0, finish: 0, cancel: 0 }, sessions = [];
  return { calls, sessions,
    async open({ start, signal, onCue, onProgress }) {
      calls.open++;
      let resolve, reject, ended = false, index = 0;
      const cues = [], done = new Promise((ok, fail) => { resolve = ok; reject = fail; });
      const emit = text => {
        if (ended) return;
        const cue = { id: `${start}_${++index}`, text, zh: `中文${index}`, start: start + index - 1, end: start + index, speaker: index % 2 };
        cues.push(cue); onCue(cue);
      };
      const cancel = () => {
        if (ended) return;
        ended = true; calls.cancel++; signal.removeEventListener('abort', cancel);
        reject(new AsrError('CANCELLED', 499));
      };
      const session = { done, emit, cancel,
        async append(input) {
          calls.append++;
          assert.equal(input.sampleRate, 16000);
          emit('First finalized sentence.'); emit('Another finalized sentence.');
        },
        finish() {
          calls.finish++;
          emit('Final sentence at the session tail.');
          ended = true; signal.removeEventListener('abort', cancel);
          resolve({ cues, usage: { input_tokens: 21 }, diagnostics: { stage: 'recognizing', finalSentences: cues.length } });
          return done;
        },
      };
      signal.addEventListener('abort', cancel, { once: true });
      onProgress({ stage: 'recognizing', elapsedMs: 1 });
      sessions.push(session);
      return session;
    },
  };
}

async function harness(t, upstream = upstreamFixture()) {
  const radio = createRadioService(upstream, { pollMs: 10, idleMs: 3000 });
  const server = createServer({ radio, translator: { mode: 'fixture', translate() { assert.fail('Unrelated translator called'); } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const service = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { radio.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const paired = await fetch(`${service}/api/session`, { headers: { Origin: service } });
  assert.equal(paired.status, 200);
  const { token } = await paired.json();
  const request = (input, headers = {}) => fetch(`${service}/api/radio`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson',
      Authorization: `Bearer ${token}`, ...headers }, body: typeof input === 'string' ? input : JSON.stringify(input),
  });
  const json = async input => {
    const response = await request(input);
    assert.equal(response.status, 200);
    return response.json();
  };
  const poll = async (sessionId, cursor) => {
    const response = await request({ action: 'poll', sessionId, cursor });
    assert.equal(response.status, 200);
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.at(-1).type, 'done');
    return { events: events.slice(0, -1), result: events.at(-1) };
  };
  return { upstream, service, token, request, json, poll };
}

test('paired JSON actions and streamed polls preserve cursor delivery through finish and its tail', async t => {
  const h = await harness(t);
  const opened = await h.json({ action: 'open', start: 100 });
  assert.equal(typeof opened.sessionId, 'string');
  assert.equal(opened.cursor, 0);
  const sessionId = opened.sessionId;
  await h.json({ action: 'append', sessionId, start: 100, sampleRate: 16000, audioBase64: 'AAA=' });
  const first = await h.poll(sessionId, 0);
  assert.equal(first.events.filter(e => e.type === 'cue').length, 2);
  assert.equal(first.events[0].type, 'progress');
  assert.equal(first.result.ended, false);
  const empty = await h.poll(sessionId, first.result.cursor);
  assert.deepEqual(empty.events, []);
  assert.equal(empty.result.cursor, first.result.cursor);
  await h.json({ action: 'append', sessionId, start: 101, sampleRate: 16000, audioBase64: 'AAA=' });
  const finished = await h.json({ action: 'finish', sessionId });
  assert.equal(finished.ended, true);
  const last = await h.poll(sessionId, empty.result.cursor);
  assert.equal(last.result.ended, true);
  assert.equal(last.events.filter(e => e.type === 'cue').length, 3);
  const all = [...first.events, ...last.events].filter(e => e.type === 'cue').map(e => e.cue.id);
  assert.equal(new Set(all).size, 5);
  assert.equal(all.length, 5);
  const final = await h.poll(sessionId, last.result.cursor);
  assert.deepEqual(final.events, []);
  assert.equal(final.result.ended, true);
  assert.deepEqual(final.result.usage, { input_tokens: 21 });
  assert.deepEqual(h.upstream.calls, { open: 1, append: 2, finish: 1, cancel: 0 });
});

function gmFetch(request) {
  const controller = new AbortController();
  void fetch(request.url, { method: request.method, headers: request.headers, body: request.data, signal: controller.signal })
    .then(response => request.onloadstart({ status: response.status, response: response.body }))
    .catch(error => error.name === 'AbortError' ? request.onabort?.() : request.onerror?.());
  return { abort: () => controller.abort() };
}

test('browser client seek cancellation closes upstream and permits a clean new session', async t => {
  const h = await harness(t), received = [];
  const client = createRadioClient(gmFetch, { service: h.service, getToken: () => h.token, timeoutMs: 2000 });
  const seek = new AbortController();
  const session = await client.open({ start: 100, signal: seek.signal, onCue: c => received.push(c) });
  await session.append({ start: 100, sampleRate: 16000, audioBase64: 'AAA=' });
  await until(() => received.length === 2);
  seek.abort();
  await assert.rejects(session.done, { code: 'CANCELLED' });
  await until(() => h.upstream.calls.cancel === 1);
  h.upstream.sessions[0].emit('Late output after seek.');
  const next = await client.open({ start: 500, onCue: c => received.push(c) });
  await next.append({ start: 500, sampleRate: 16000, audioBase64: 'AAA=' });
  await next.finish();
  assert.equal(received.filter(c => c.start < 500).length, 2);
  assert.equal(received.filter(c => c.start >= 500).length, 3);
  assert.equal(h.upstream.calls.open, 2);
});

test('unauthorized, malformed and invalid session requests never open the upstream', async t => {
  const h = await harness(t);
  for (const [input, headers, status, code] of [
    [{ action: 'open', start: 0 }, { Authorization: 'Bearer wrong' }, 401, 'UNAUTHORIZED'],
    [{ action: 'open', start: 0 }, { Origin: 'https://untrusted.example' }, 401, 'UNAUTHORIZED'],
    ['not valid JSON', {}, 400, 'INVALID_JSON'],
    [{ action: 'open', start: -1 }, {}, 400, 'ASR_INVALID_AUDIO'],
    [{ action: 'append', sessionId: 'missing' }, {}, 409, 'ASR_SESSION_EXPIRED'],
    [{ action: 'unexpected' }, {}, 409, 'ASR_SESSION_EXPIRED'],
  ]) {
    const response = await h.request(input, headers);
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, code);
  }
  assert.deepEqual(h.upstream.calls, { open: 0, append: 0, finish: 0, cancel: 0 });
});
