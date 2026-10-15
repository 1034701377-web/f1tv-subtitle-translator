import test from 'node:test';
import assert from 'node:assert/strict';
import { createTranslator, readConfig } from '../lib/translator.mjs';
import { TRANSLATION_PROMPT, TR_ASR_PROMPT } from '../lib/translation-prompt.mjs';

const input = { cue: { id: 'cue-1', text: 'The gap is now 1.8 seconds.', start: 10, end: 14 }, context: [{ text: 'Norris is closing in.' }] };

test('mock has complete translations and explicit unknown fallback; failure and cancellation are bounded', async () => {
  const translator = createTranslator({ mode: 'mock' });
  assert.equal((await translator.translate({ ...input, mockDelayMs: 0 })).text, '目前差距是 1.8 秒。');
  assert.match((await translator.translate({ cue: { ...input.cue, text: 'Unknown cue' }, mockDelayMs: 0 })).text, /^\[模拟译文\]/);
  await assert.rejects(translator.translate({ ...input, mockDelayMs: 0, mockFail: true }), { code: 'MOCK_FAILURE' });
  await assert.rejects(translator.translate({ ...input, mockDelayMs: 30001 }), { code: 'INVALID_MOCK_DELAY' });
  await assert.rejects(translator.translate({ ...input, cue: { ...input.cue, end: 1 } }), { code: 'INVALID_CUE' });
  await assert.rejects(translator.translate(input, { signal: AbortSignal.abort() }), { code: 'CANCELLED' });
});

test('API sends complete non-streaming compatible request, context, glossary and configured credentials', async () => {
  const config = { mode: 'api', endpoint: 'https://provider.example/chat/completions', model: 'test-model', key: 'test-secret', timeoutMs: 1000 };
  let calls = 0;
  const translator = createTranslator(config, { fetchImpl: async (endpoint, init) => {
    calls++;
    assert.equal(endpoint, config.endpoint);
    assert.equal(init.headers.Authorization, 'Bearer test-secret');
    assert.equal(init.redirect, 'error');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'test-model');
    assert.equal(body.stream, false);
    assert.equal(Object.hasOwn(body, 'thinking'), false);
    assert.deepEqual(JSON.parse(body.messages[1].content), {
      before: [], current: input.cue.text, after: [], context_unordered: [{text: 'Norris is closing in.'}], duration_seconds: 4,
    });
    assert.match(body.messages[0].content, /简体中文/);
    assert.match(body.messages[0].content, /安全车/);
    return Response.json({ choices: [{ message: { content: '差距是 1.8 秒。' } }] });
  } });
  assert.deepEqual(await translator.translate({ ...input, mockFail: true, mockDelayMs: 30000 }), { text: '差距是 1.8 秒。' });
  assert.equal(calls, 1);
});

test('context direction and times reach the model without translating or trusting unknown order', async () => {
  let payload;
  const translator = createTranslator({mode:'api',endpoint:'https://provider.example',model:'test',key:'fixture-key'}, {
    fetchImpl: async (_, init) => {
      payload = JSON.parse(JSON.parse(init.body).messages[1].content);
      return Response.json({choices:[{message:{content:'他现在需要的是'}}]});
    },
  });
  const cue = {id:'part',start:10,end:12,text:'What he needs now'};
  const context = [
    {text:'Norris is close.',position:'before',start:8,end:10},
    {text:'is a clean exit.',position:'after',start:12,end:14},
    {text:'Legacy context without direction'},
  ];
  assert.deepEqual(await translator.translate({cue,context}), {text:'他现在需要的是'});
  assert.deepEqual(payload, {before:[{text:'Norris is close.',start:8,end:10}],current:cue.text,
    after:[{text:'is a clean exit.',start:12,end:14}],context_unordered:[{text:'Legacy context without direction'}],duration_seconds:2});
  for (const invalid of [{text:'x',position:'system'}, {text:'x',start:12}, {text:'x',start:15,end:13}]) {
    await assert.rejects(translator.translate({cue,context:[invalid]}), {code:'INVALID_CONTEXT'});
  }
});

test('only existing Track FX ids get ASR repair guidance; multilingual input and context stay intact', async () => {
  const requests = [];
  const translator = createTranslator({mode:'api',endpoint:'https://provider.example',model:'test',key:'fixture-key'}, {
    fetchImpl: async (_, init) => {
      requests.push(JSON.parse(init.body));
      return Response.json({choices:[{message:{content:'刹车没问题。'}}]});
    },
  });
  const text = 'لا توجد مشكلة في الفرامل. Box cette fois.';
  const context = [{text:'Are you sure about the truck limit?',position:'before',start:6,end:9}];
  for (const id of ['fx:extension-0:10000:sample', 'vtt:10000:sample', 'unknown']) {
    await translator.translate({cue:{id,text,start:10,end:14},context});
  }
  assert.equal(requests[0].messages[0].content, TRANSLATION_PROMPT + TR_ASR_PROMPT);
  for (const request of requests.slice(1)) assert.equal(request.messages[0].content, TRANSLATION_PROMPT);
  for (const request of requests) assert.deepEqual(JSON.parse(request.messages[1].content), {
    before:[{text:context[0].text,start:6,end:9}],current:text,after:[],context_unordered:[],duration_seconds:4,
  });
});

test('API thinking sends the configured type and omits the parameter when blank or unset', async () => {
  for (const thinking of ['disabled', 'enabled', '', undefined]) {
    const config = readConfig({
      TRANSLATION_MODE: 'api', API_ENDPOINT: 'https://provider.example/chat/completions',
      API_MODEL: 'test-model', API_KEY: 'test-secret', API_THINKING: thinking,
    });
    let body;
    const translator = createTranslator(config, { fetchImpl: async (_, init) => {
      body = JSON.parse(init.body);
      return Response.json({ choices: [{ message: { content: '差距是 1.8 秒。' } }] });
    } });
    await translator.translate(input);
    if (thinking) assert.deepEqual(body.thinking, { type: thinking });
    else assert.equal(Object.hasOwn(body, 'thinking'), false);
  }
});

test('API timeout and upstream failure produce safe codes, never echo provider errors or retry', async () => {
  const config = { mode: 'api', endpoint: 'https://provider.example/chat/completions', model: 'test', key: 'secret-that-must-stay-private', timeoutMs: 20 };
  let signal;
  const slow = createTranslator(config, { fetchImpl: async (_, init) => { signal = init.signal; return new Promise(() => {}); } });
  await assert.rejects(slow.translate(input), { code: 'TRANSLATION_TIMEOUT', status: 504 });
  assert.equal(signal.aborted, true);
  let calls = 0;
  const failed = createTranslator(config, { fetchImpl: async () => {
    calls++;
    return new Response('secret-that-must-stay-private', { status: 401 });
  } });
  await assert.rejects(failed.translate(input), error => {
    assert.equal(error.code, 'UPSTREAM_AUTH_FAILED');
    assert.equal(error.message.includes(config.key), false);
    return true;
  });
  assert.equal(calls, 1);
  const malformed = createTranslator(config, { fetchImpl: async () => Response.json({ choices: [] }) });
  await assert.rejects(malformed.translate(input), { code: 'INVALID_UPSTREAM_RESPONSE' });
});

test('API maps upstream HTTP failures, cancels unread error bodies and never retries', async () => {
  const config = { mode: 'api', endpoint: 'https://provider.example/chat/completions', model: 'test', key: 'fixture-key', timeoutMs: 1000 };
  const cases = [
    [401, 'UPSTREAM_AUTH_FAILED', 502],
    [403, 'UPSTREAM_AUTH_FAILED', 502],
    [402, 'UPSTREAM_BALANCE', 502],
    [429, 'UPSTREAM_RATE_LIMITED', 503],
    [500, 'UPSTREAM_UNAVAILABLE', 502],
    [503, 'UPSTREAM_UNAVAILABLE', 502],
    [599, 'UPSTREAM_UNAVAILABLE', 502],
    [301, 'UPSTREAM_REJECTED', 502],
    [400, 'UPSTREAM_REJECTED', 502],
    [404, 'UPSTREAM_REJECTED', 502],
  ];
  for (const [upstreamStatus, code, status] of cases) {
    let calls = 0;
    let bodyReads = 0;
    let cancellations = 0;
    const translator = createTranslator(config, { fetchImpl: async () => {
      calls++;
      return {
        ok: false,
        status: upstreamStatus,
        body: { cancel: async () => { cancellations++; if (upstreamStatus === 500) throw Error('cancel failed'); } },
        text() { bodyReads++; throw new Error('Unexpected error body access'); },
      };
    } });
    await assert.rejects(translator.translate(input), { code, status, message: code });
    assert.equal(calls, 1, `HTTP ${upstreamStatus} should not retry`);
    assert.equal(bodyReads, 0, `HTTP ${upstreamStatus} should not read its error body`);
    assert.equal(cancellations, 1, `HTTP ${upstreamStatus} should cancel its error body`);
  }
});

test('configuration defaults to mock and rejects missing credentials or insecure remote HTTP', () => {
  assert.equal(readConfig({}).mode, 'mock');
  assert.throws(() => readConfig({ API_THINKING: 'auto' }), { code: 'INVALID_CONFIG' });
  assert.throws(() => readConfig({ TRANSLATION_MODE: 'api' }), { code: 'INVALID_CONFIG' });
  assert.throws(() => readConfig({ TRANSLATION_MODE: 'api', API_ENDPOINT: 'http://remote.example/api', API_MODEL: 'test', API_KEY: 'secret' }), { code: 'INVALID_CONFIG' });
  assert.equal(readConfig({ TRANSLATION_MODE: 'api', API_ENDPOINT: 'http://127.0.0.1:8000/v1/chat/completions', API_MODEL: 'test', API_KEY: 'local' }).mode, 'api');
});
