import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAsr, readAsrConfig } from '../lib/qwen-asr.mjs';

const config = {
  apiKey: 'fixture-secret', endpoint: 'wss://fixture.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference',
  model: 'qwen-audio-3.1-asr-flash-streaming', timeoutMs: 1000,
};
const input = { audioBase64: Buffer.alloc(16000 * 2).toString('base64'), sampleRate: 16000, start: 2040 };

function fixture({ opened, sent, autoOpen = true, holdBinary = false } = {}) {
  const sockets = [];
  class FakeWebSocket extends EventEmitter {
    constructor(endpoint, options) {
      super();
      this.endpoint = endpoint;
      this.options = options;
      this.readyState = 0;
      this.frames = [];
      this.activeWrites = 0;
      this.maxWrites = 0;
      sockets.push(this);
      if (autoOpen) queueMicrotask(() => {
        if (this.readyState === 3) return;
        this.readyState = 1;
        this.emit('open');
        opened?.(this);
      });
    }
    send(data, options, callback) {
      this.frames.push({ data, options });
      if (options.binary) this.activeWrites++;
      this.maxWrites = Math.max(this.maxWrites, this.activeWrites);
      if (!options.binary) {
        const message = JSON.parse(data);
        this.taskId = message.header.task_id;
        if (message.header.action === 'run-task') queueMicrotask(() => this.event('task-started'));
      }
      if (options.binary && holdBinary) return;
      queueMicrotask(() => {
        if (options.binary) this.activeWrites--;
        callback();
        sent?.(this, data, options);
      });
    }
    event(event, payload = {}, header = {}) {
      this.emit('message', Buffer.from(JSON.stringify({ header: { event, task_id: this.taskId, ...header }, payload })), false);
    }
    close() { this.closed = true; this.readyState = 3; this.emit('close'); }
    terminate() { this.terminated = true; this.readyState = 3; this.emit('close'); }
  }
  return { WebSocketImpl: FakeWebSocket, sockets };
}

function onFinish(handler) {
  return (socket, data, options) => {
    if (!options.binary && JSON.parse(data).header.action === 'finish-task') handler(socket);
  };
}

function sentence(socket, data, usage) {
  socket.event('result-generated', { output: { sentence: data }, ...(usage ? { usage } : {}) });
}

test('ASR config remains optional and rejects unsafe or incomplete settings', () => {
  assert.equal(readAsrConfig({}), null);
  assert.equal(readAsrConfig({ DASHSCOPE_API_KEY: 'shared-key' }), null);
  const env = { ASR_ENDPOINT: config.endpoint, ASR_MODEL: config.model, DASHSCOPE_API_KEY: config.apiKey };
  assert.deepEqual(readAsrConfig(env), { ...config, timeoutMs: 25000 });
  for (const override of [
    { DASHSCOPE_API_KEY: '' }, { ASR_ENDPOINT: 'https://example.com' }, { ASR_ENDPOINT: 'wss://name:pass@example.com/' },
    { ASR_ENDPOINT: 'wss://example.com/?token=secret' }, { ASR_MODEL: '' }, { ASR_TIMEOUT_MS: 'NaN' },
    { ASR_TIMEOUT_MS: '0' }, { ASR_TIMEOUT_MS: '120001' }, { DASHSCOPE_API_KEY: 'key\r\ninjected' },
  ]) assert.throws(() => readAsrConfig({ ...env, ...override }), { code: 'ASR_INVALID_CONFIG' });
});

test('protocol writes bounded 100 ms PCM frames, maps final times, filters drafts and empty speech, keeps last usage', async () => {
  const mock = fixture({ sent: onFinish(socket => {
    sentence(socket, { sentence_id: 1, begin_time: 0, end_time: null, text: 'draft', sentence_end: false });
    sentence(socket, { sentence_id: 0, heartbeat: true, text: 'heartbeat', sentence_end: true });
    sentence(socket, { sentence_id: 1, begin_time: 0, end_time: 10, text: '  ', sentence_end: true });
    sentence(socket, { sentence_id: 2, begin_time: 150, end_time: 650, text: ' Box, box. ', sentence_end: true },
      { input_tokens: 10, output_tokens: 2, total_tokens: 12, duration: 1 });
    sentence(socket, { sentence_id: 2, begin_time: 150, end_time: 650, text: ' Box, box. ', sentence_end: true });
    sentence(socket, { sentence_id: 3, begin_time: 650, end_time: 990, text: 'Incomplete', sentence_end: false });
    socket.event('task-finished', { usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15, duration: 1, private: config.apiKey } });
  }) });
  const result = await createAsr(config, mock).transcribe(input);
  assert.deepEqual(result, { cues: [{ text: 'Box, box.', start: 2040.15, end: 2040.65 }],
    usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15, duration: 1 } });
  const [socket] = mock.sockets;
  assert.equal(socket.options.headers.Authorization, `Bearer ${config.apiKey}`);
  assert.equal(socket.options.followRedirects, false);
  assert.equal(socket.maxWrites, 1);
  assert.equal(socket.closed, true);
  const commands = socket.frames.filter(frame => !frame.options.binary).map(frame => JSON.parse(frame.data));
  assert.equal(commands[0].header.action, 'run-task');
  assert.equal(commands[1].header.action, 'finish-task');
  assert.equal(commands[0].header.task_id, commands[1].header.task_id);
  assert.deepEqual(commands[0].payload, { task_group: 'audio', task: 'asr', function: 'recognition', model: config.model,
    parameters: { format: 'pcm', sample_rate: 16000,
      semantic_punctuation_enabled: false, max_sentence_silence: 800, multi_threshold_mode_enabled: true }, input: {} });
  assert.equal(JSON.stringify(commands).includes(config.apiKey), false);
  const audioFrames = socket.frames.filter(frame => frame.options.binary);
  assert.equal(audioFrames.length, 10);
  assert.ok(audioFrames.every(frame => frame.data.length === 3200));
  assert.deepEqual(Buffer.concat(audioFrames.map(frame => frame.data)), Buffer.from(input.audioBase64, 'base64'));
});

test('silence is a valid empty result and a final short PCM frame is preserved', async () => {
  const mock = fixture({ sent: onFinish(socket => socket.event('task-finished')) });
  assert.deepEqual(await createAsr(config, mock).transcribe({ ...input, audioBase64: Buffer.alloc(3202).toString('base64') }), { cues: [], usage: {} });
  assert.deepEqual(mock.sockets[0].frames.filter(frame => frame.options.binary).map(frame => frame.data.length), [3200, 2]);
});

test('invalid PCM, duration, sample rate and absolute time reject before opening a connection', async () => {
  const mock = fixture();
  const asr = createAsr(config, mock);
  for (const override of [
    { sampleRate: 44100 }, { start: -1 }, { start: NaN }, { start: Infinity }, { start: 1e10 },
    { audioBase64: '' }, { audioBase64: '%%%=' }, { audioBase64: 'YQ==' }, { audioBase64: 'AAAA====' },
    { audioBase64: Buffer.alloc(960002).toString('base64') },
  ]) await assert.rejects(asr.transcribe({ ...input, ...override }), { code: 'ASR_INVALID_AUDIO', status: 400 });
  assert.equal(mock.sockets.length, 0);
  await assert.rejects(createAsr(null, mock).transcribe(input), { code: 'ASR_NOT_CONFIGURED', status: 503 });
});

test('cancellation before connect, during connect and while a frame is pending closes promptly', async () => {
  const unopened = fixture();
  await assert.rejects(createAsr(config, unopened).transcribe(input, { signal: AbortSignal.abort() }), { code: 'CANCELLED', status: 499 });
  assert.equal(unopened.sockets.length, 0);
  for (const options of [{ autoOpen: false }, { holdBinary: true }]) {
    const mock = fixture(options);
    const controller = new AbortController();
    const pending = createAsr(config, mock).transcribe(input, { signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await assert.rejects(pending, { code: 'CANCELLED', status: 499 });
    assert.equal(mock.sockets[0].terminated, true);
    mock.sockets[0].emit('error', new Error('provider includes fixture-secret'));
  }
});

test('timeout terminates a pending connection or stalled audio write', async () => {
  for (const options of [{ autoOpen: false }, { holdBinary: true }]) {
    const mock = fixture(options);
    await assert.rejects(createAsr({ ...config, timeoutMs: 50 }, mock).transcribe(input), {
      code: options.autoOpen === false ? 'ASR_CONNECT_TIMEOUT' : 'ASR_SEND_TIMEOUT', status: 504 });
    assert.equal(mock.sockets[0].terminated, true);
  }
});

test('waiting for task completion reports sent duration and event timing', async () => {
  const mock=fixture(), progress=[];
  await assert.rejects(createAsr({...config,timeoutMs:50},mock).transcribe(input,{onProgress:d=>progress.push(d)}),error=>{
    assert.equal(error.code,'ASR_FINISH_TIMEOUT');
    assert.equal(error.diagnostics.sentAudioMs,1000);
    assert.equal(error.diagnostics.stage,'recognizing');
    assert.ok(Number.isFinite(error.diagnostics.finishSentMs));
    assert.equal(JSON.stringify(error).includes(config.apiKey),false);
    return true;
  });
  assert.deepEqual(progress.map(d=>d.stage),['starting','sending','recognizing']);
});

test('HTTP handshake auth failures and protocol failures expose safe codes only', async () => {
  for (const [statusCode, code] of [[401, 'ASR_AUTH_FAILED'], [403, 'ASR_AUTH_FAILED'], [429, 'ASR_RATE_LIMITED'], [500, 'ASR_UPSTREAM_FAILED']]) {
    const mock = fixture({ opened: socket => socket.emit('unexpected-response', {}, { statusCode, destroy() {} }) });
    await assert.rejects(createAsr(config, mock).transcribe(input), error => error.code === code && error.message === code);
  }
  const mock = fixture({ sent: onFinish(socket => socket.event('task-failed', {}, {
    error_code: 'InvalidApiKey', error_message: `Your key ${config.apiKey} is invalid`,
  })) });
  await assert.rejects(createAsr(config, mock).transcribe(input), error => {
    assert.equal(error.code, 'ASR_AUTH_FAILED');
    assert.equal(JSON.stringify(error).includes(config.apiKey), false);
    assert.equal(error.message.includes(config.apiKey), false);
    return true;
  });
});

test('out of range timestamps and malformed or mismatched responses fail safely', async () => {
  for (const action of [
    socket => sentence(socket, { text: 'x', begin_time: -1, end_time: 200, sentence_end: true }),
    socket => sentence(socket, { text: 'x', begin_time: 0, end_time: 1001, sentence_end: true }),
    socket => socket.emit('message', Buffer.from('upstream secret error'), false),
    socket => socket.event('task-finished', {}, { task_id: 'different' }),
    socket => socket.emit('message', Buffer.alloc(65537), false),
  ]) {
    const mock = fixture({ sent: onFinish(action) });
    await assert.rejects(createAsr(config, mock).transcribe(input), { code: 'ASR_INVALID_RESPONSE' });
    assert.equal(mock.sockets[0].terminated, true);
  }
});

test('a socket close before task completion never returns partial captions as success', async () => {
  const mock = fixture({ sent: onFinish(socket => {
    sentence(socket, { text: 'Box', begin_time: 0, end_time: 500, sentence_end: true });
    socket.close();
  }) });
  await assert.rejects(createAsr(config, mock).transcribe(input), { code: 'ASR_CONNECTION_CLOSED' });
});

test('onCue delivers validated final speech before task-finished and freezes the first final sentence ID', async () => {
  let firstCue;
  const early = new Promise(resolve => { firstCue = resolve; });
  const received = [];
  const mock = fixture({ sent: onFinish(socket => {
    sentence(socket, { sentence_id: 1, text: 'draft', begin_time: 0, end_time: null, sentence_end: false });
    sentence(socket, { sentence_id: 0, text: 'heartbeat', heartbeat: true, sentence_end: true });
    sentence(socket, { sentence_id: 2, text: ' ', sentence_end: true });
    sentence(socket, { sentence_id: 3, text: 'Box now.', begin_time: 100, end_time: 600, sentence_end: true });
    sentence(socket, { sentence_id: 3, text: 'Do not replace the first final.', begin_time: 100, end_time: 700, sentence_end: true });
  }) });
  let finished = false;
  const task = createAsr(config, mock).transcribe(input, { onCue: cue => { received.push(cue); firstCue(cue); } });
  task.then(() => { finished = true; });
  assert.deepEqual(await early, { text: 'Box now.', start: 2040.1, end: 2040.6 });
  assert.equal(finished, false);
  assert.equal(received.length, 1);
  assert.equal(Object.isFrozen(received[0]), true);
  mock.sockets[0].event('task-finished');
  assert.deepEqual((await task).cues, received);
});

test('onCue never receives out-of-range results and stops immediately after cancellation', async () => {
  const invalid = fixture({ sent: onFinish(socket => {
    sentence(socket, { sentence_id: 1, text: 'Outside', begin_time: 0, end_time: 1001, sentence_end: true });
  }) });
  const received = [];
  await assert.rejects(createAsr(config, invalid).transcribe(input, { onCue: cue => received.push(cue) }), { code: 'ASR_INVALID_RESPONSE' });
  assert.equal(received.length, 0);
  const abort = new AbortController();
  const mock = fixture({ sent: onFinish(socket => {
    sentence(socket, { sentence_id: 1, text: 'First', begin_time: 0, end_time: 500, sentence_end: true });
    sentence(socket, { sentence_id: 2, text: 'After cancellation', begin_time: 500, end_time: 1000, sentence_end: true });
    socket.event('task-finished');
  }) });
  await assert.rejects(createAsr(config, mock).transcribe(input, {
    signal: abort.signal, onCue: cue => { received.push(cue); abort.abort(); },
  }), { code: 'CANCELLED' });
  assert.deepEqual(received, [{ text: 'First', start: 2040, end: 2040.5 }]);
  assert.equal(mock.sockets[0].terminated, true);
});

test('final word timestamps split an interview question and answer at provider punctuation without joining apostrophe fragments', async () => {
  const w = (text, begin_time, end_time, punctuation = '') => ({ text, begin_time, end_time, punctuation, fixed: true });
  const words = [
    w('Special', 200, 1000), w(' around', 1000, 2000), w(' here', 3960, 4080, '.'),
    w(' So', 4200, 4700, ','), w(' congratulations', 5640, 6240, '.'),
    w(' Can', 6400, 6700), w(' you', 6700, 7000), w(' talk', 7000, 7300), w(' us', 7300, 7600),
    w(' through', 7600, 7900), w(' your', 7900, 8200), w(' lap', 8720, 9080, '?'),
    w(' You', 10000, 11000), w(' were', 12000, 13000), w(' on', 14000, 15000), w(' pole', 17000, 18000), w(' today', 18480, 18760, '.'),
    w(' That', 19000, 19500), w("'s", 19500, 19800), w(' an', 19900, 21000), w(' incredible', 22000, 22800), w(' performance', 23240, 23720, '.'),
    w(' He', 24000, 25000), w(' beat', 25000, 26000), w(' me', 27000, 28000), w(' there', 28680, 28960, '.'),
    w(' And', 29000, 29100), w(' I', 29100, 29200), w(' thought', 29200, 29500, ','), w(' well', 29760, 29840, ', '),
  ];
  const text = words.map(word => word.text + word.punctuation).join('').trim(), received = [];
  const mock = fixture({ sent: onFinish(socket => {
    const final = { sentence_id: 7, begin_time: 200, end_time: 29840, text, sentence_end: true, words };
    sentence(socket, final);
    assert.equal(received.length, 7); // All final parts arrive before task completion.
    sentence(socket, { ...final, text: 'A repeated sentence ID must not revise the parts.' });
    socket.event('task-finished');
  }) });
  const result = await createAsr(config, mock).transcribe({ ...input, start: 4360, audioBase64: Buffer.alloc(960000).toString('base64') },
    { onCue: value => received.push(value) });
  assert.deepEqual(result.cues.map(({ text, start, end }) => ({ text, start, end })), [
    { text: 'Special around here.', start: 4360.2, end: 4364.08 },
    { text: 'So, congratulations.', start: 4364.2, end: 4366.24 },
    { text: 'Can you talk us through your lap?', start: 4366.4, end: 4369.08 },
    { text: 'You were on pole today.', start: 4370, end: 4378.76 },
    { text: "That's an incredible performance.", start: 4379, end: 4383.72 },
    { text: 'He beat me there.', start: 4384, end: 4388.96 },
    { text: 'And I thought, well,', start: 4389, end: 4389.84 },
  ]);
  assert.deepEqual(result.cues, received);
  assert.ok(result.cues.every((part, index) => part.id === `asr:4360:200:29840:7:part:${index}` && Object.isFrozen(part)));
  assert.equal(result.cues.map(part => part.text).join(' '), text);
});

test('malformed, unfixed, overlapping or mismatched words conservatively keep the original final sentence', async () => {
  const valid = [
    { text: 'Box', begin_time: 100, end_time: 250, punctuation: '', fixed: true },
    { text: ' now', begin_time: 250, end_time: 500, punctuation: '.', fixed: true },
  ];
  const variants = [
    'not an array', [],
    [{ ...valid[0], fixed: false }, valid[1]],
    [{ ...valid[0], begin_time: 99 }, valid[1]],
    [valid[0], { ...valid[1], begin_time: 249 }],
    [valid[0], { ...valid[1], end_time: 501 }],
    [valid[0], { ...valid[1], text: ' later' }],
    [valid[0], { ...valid[1], punctuation: null }],
  ];
  for (const words of variants) {
    const mock = fixture({ sent: onFinish(socket => {
      sentence(socket, { sentence_id: 1, begin_time: 100, end_time: 500, text: 'Box now.', sentence_end: true, words });
      socket.event('task-finished');
    }) });
    assert.deepEqual((await createAsr(config, mock).transcribe(input)).cues,
      [{ text: 'Box now.', start: 2040.1, end: 2040.5 }]);
  }
});
