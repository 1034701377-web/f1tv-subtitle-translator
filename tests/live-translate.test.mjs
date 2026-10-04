import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLiveTranslator } from '../lib/live-translate.mjs';

const config = { endpoint: 'wss://fixture.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference',
  apiKey: 'fixture-secret', model: 'qwen3.8-livetranslate-flash-realtime', timeoutMs: 1000 };
const input = (start = 100, seconds = 1) => ({ start, sampleRate: 16000,
  audioBase64: Buffer.alloc(Math.round(seconds * 32000)).toString('base64') });

function fixture({ autoOpen = true, autoUpdate = true, autoFinish = true, holdAudio = false, onSend } = {}) {
  const sockets = [];
  class FakeWebSocket extends EventEmitter {
    constructor(endpoint, options) {
      super();
      Object.assign(this, { endpoint, options, readyState: 0, frames: [] });
      sockets.push(this);
      if (autoOpen) queueMicrotask(() => {
        if (this.readyState === 3) return;
        this.readyState = 1;
        this.emit('open');
      });
    }
    send(raw, options, callback) {
      const event = JSON.parse(raw);
      this.frames.push(event);
      if (holdAudio && event.type === 'input_audio_buffer.append') return;
      queueMicrotask(() => {
        callback();
        if (event.type === 'session.update' && autoUpdate) this.event({ type: 'session.updated', session: event.session });
        onSend?.(this, event);
        if (event.type === 'session.finish' && autoFinish) this.event({ type: 'session.finished' });
      });
    }
    event(event) { this.emit('message', Buffer.from(JSON.stringify(event)), false); }
    close() { this.closed = true; this.readyState = 3; this.emit('close'); }
    terminate() { this.terminated = true; this.readyState = 3; this.emit('close'); }
  }
  return { WebSocketImpl: FakeWebSocket, sockets, pace: 1000 };
}

function source(socket, id, { begin = 0, end = 500, speaker = 1, text = 'Box now.' } = {}) {
  socket.event({ type: 'input_audio_buffer.speech_started', item_id: id, audio_start_ms: begin, speaker_id: speaker });
  socket.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: text });
  socket.event({ type: 'input_audio_buffer.speech_stopped', item_id: id, audio_end_ms: end });
}

function translation(socket, id, sourceId, text, status = 'completed') {
  socket.event({ type: 'conversation.item.created', previous_item_id: sourceId, item: { id, role: 'assistant' } });
  response(socket, id, text, status);
}

function response(socket, id, text, status = 'completed') {
  socket.event({ type: 'response.done', response: { id: `resp_${id}`, status,
    output: [{ id, role: 'assistant', status, content: [{ type: 'text', text }] }],
    usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9, private: config.apiKey } } });
}

test('configuration waits for acknowledgment and sends bounded paced PCM without exposing credentials', async () => {
  const mock = fixture({ autoUpdate: false }), progress = [];
  let ready = false;
  const opening = createLiveTranslator(config, mock).open({ start: 100, onProgress: d => progress.push(d) });
  opening.then(() => { ready = true; });
  await new Promise(resolve => setImmediate(resolve));
  const [socket] = mock.sockets;
  assert.equal(ready, false);
  assert.equal(socket.endpoint, 'wss://fixture.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-livetranslate-flash-realtime');
  assert.equal(socket.options.headers.Authorization, 'Bearer fixture-secret');
  assert.equal(socket.options.followRedirects, false);
  socket.event({ type: 'session.updated', session: socket.frames[0].session });
  const session = await opening;
  await session.append(input(100, 0.1000625));
  assert.deepEqual(socket.frames.filter(e => e.audio).map(e => Buffer.from(e.audio, 'base64').length), [3200, 2]);
  const ending = session.finish();
  assert.equal(ending, session.done);
  assert.equal(session.finish(), ending);
  const result = await ending;
  assert.deepEqual(result.cues, []);
  assert.equal(result.diagnostics.sentAudioMs, 100.0625);
  assert.equal(JSON.stringify({ frames: socket.frames, result, progress }).includes(config.apiKey), false);
  assert.equal(socket.closed, true);
});

test('3.5 uses its own session schema and ignores provisional text and stash until explicitly associated finals', async () => {
  const mock = fixture(), cues = [];
  const session = await createLiveTranslator({ ...config, model: 'qwen3.5-livetranslate-flash-realtime' }, mock)
    .open({ start: 100, onCue: c => cues.push(c) });
  const [socket] = mock.sockets;
  assert.deepEqual(socket.frames[0].session, {
    modalities: ['text'], translation: { language: 'zh' }, input_audio_format: 'pcm', sample_rate: 16000,
    input_audio_transcription: { model: 'qwen3-asr-flash-realtime', language: 'en' },
    turn_detection: { type: 'server_vad', threshold: 0.2, silence_duration_ms: 1000 },
  });
  assert.ok(socket.endpoint.endsWith('?model=qwen3.5-livetranslate-flash-realtime'));
  await session.append(input());
  socket.event({ type: 'input_audio_buffer.speech_started', item_id: 'source35', audio_start_ms: 100 });
  socket.event({ type: 'conversation.item.input_audio_transcription.text', item_id: 'source35', text: 'It is', stash: 'still drivable.' });
  socket.event({ type: 'response.text.text', item_id: 'output35', response_id: 'resp35', text: '这车', stash: '还能开。' });
  socket.event({ type: 'response.text.text', item_id: 'output35', response_id: 'resp35', text: '这车实在', stash: '没法开。' });
  socket.event({ type: 'response.text.done', item_id: 'output35', response_id: 'resp35', text: '这车实在没法开。' });
  socket.event({ type: 'response.done', response: { id: 'resp35', status: 'completed',
    output: [{ id: 'output35', role: 'assistant', status: 'completed', content: [] }] } });
  assert.equal(cues.length, 0);
  socket.event({ type: 'input_audio_buffer.speech_stopped', item_id: 'source35', audio_end_ms: 900 });
  socket.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'source35', transcript: 'It is really undrivable.' });
  assert.equal(cues.length, 0); // Matching arrival order never substitutes for the explicit backlink.
  socket.event({ type: 'conversation.item.created', previous_item_id: 'source35',
    item: { id: 'output35', role: 'assistant', content: [] } });
  assert.deepEqual(cues, [{ id: 'live:100:output35', text: 'It is really undrivable.', zh: '这车实在没法开。', start: 100.1, end: 100.9 }]);
  assert.deepEqual((await session.finish()).cues, cues);
});

test('3.5 and 3.8 reject the other model configuration schema or a non-Chinese target', async () => {
  for (const [model, wrongSession] of [
    ['qwen3.5-livetranslate-flash-realtime', { output_modalities: ['text'], translation: { language: 'zh' } }],
    ['qwen3.8-livetranslate-flash-realtime', { modalities: ['text'], translation: { language: 'zh' } }],
    ['qwen3.5-livetranslate-flash-realtime', { modalities: ['text'], translation: { language: 'en' } }],
  ]) {
    const mock = fixture({ autoUpdate: false, onSend(socket, event) {
      if (event.type === 'session.update') socket.event({ type: 'session.updated', session: wrongSession });
    } });
    await assert.rejects(createLiveTranslator({ ...config, model }, mock).open({ start: 100 }), { code: 'ASR_INVALID_RESPONSE' });
  }
  assert.throws(() => createLiveTranslator({ ...config, model: 'qwen3-livetranslate-flash-realtime' }), { code: 'ASR_INVALID_CONFIG' });
});

test('out of order association separates interviewer and driver and delivers before session finish', async () => {
  const mock = fixture(), cues = [];
  const session = await createLiveTranslator(config, mock).open({ start: 100, onCue: cue => cues.push(cue) });
  await session.append(input());
  const [socket] = mock.sockets;
  // Translation B finishes before its source and before translation A.
  response(socket, 'answer', '非常感谢。');
  source(socket, 'question_source', { begin: 0, end: 450, speaker: 1, text: 'How was the lap?' });
  source(socket, 'answer_source', { begin: 500, end: 1000, speaker: 2, text: 'Thank you very much.' });
  assert.equal(cues.length, 0);
  socket.event({ type: 'conversation.item.created', previous_item_id: 'answer_source', item: { id: 'answer', role: 'assistant' } });
  translation(socket, 'question', 'question_source', '这一圈怎么样？');
  assert.deepEqual(cues.map(({ text, zh, start, end, speaker }) => ({ text, zh, start, end, speaker })), [
    { text: 'Thank you very much.', zh: '非常感谢。', start: 100.5, end: 101, speaker: 2 },
    { text: 'How was the lap?', zh: '这一圈怎么样？', start: 100, end: 100.45, speaker: 1 },
  ]);
  assert.ok(cues.every(Object.isFrozen));
  assert.equal(socket.frames.some(e => e.type === 'session.finish'), false);
  // Repeated final responses cannot change delivered captions or double count usage.
  response(socket, 'answer', 'Different');
  assert.equal(cues.length, 2);
  const result = await session.finish();
  assert.deepEqual(result.cues.map(c => c.speaker), [1, 2]);
  assert.deepEqual(result.usage, { input_tokens: 14, output_tokens: 4, total_tokens: 18 });
});

test('live 3.8 assistant-role input_audio item is a source without previous_item_id', async () => {
  const mock = fixture(), cues = [];
  const session = await createLiveTranslator(config, mock).open({ start: 100, onCue: c => cues.push(c) });
  await session.append(input());
  const [socket] = mock.sockets;
  socket.event({ type: 'input_audio_buffer.speech_started', item_id: 'item_source', audio_start_ms: 0, speaker_id: 1 });
  socket.event({ type: 'conversation.item.created', item: { id: 'item_source', object: 'realtime.item',
    type: 'message', status: 'in_progress', role: 'assistant', content: [{ type: 'input_audio' }] } });
  socket.event({ type: 'response.created', response: { id: 'resp_item_translation', status: 'in_progress' } });
  socket.event({ type: 'response.output_item.added', response_id: 'resp_item_translation', output_index: 0,
    item: { id: 'item_translation', role: 'assistant', content: [] } });
  socket.event({ type: 'conversation.item.created', previous_item_id: 'item_source',
    item: { id: 'item_translation', role: 'assistant', content: [] } });
  socket.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_source', transcript: 'Box now.' });
  socket.event({ type: 'input_audio_buffer.speech_stopped', item_id: 'item_source', audio_end_ms: 1000 });
  response(socket, 'item_translation', '现在进站。');
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'Box now.');
  assert.equal(cues[0].speaker, 1);
  assert.equal((await session.finish()).cues[0].zh, '现在进站。');
});

test('delta and text.done alone are not final; a final tail arrives after finish is sent', async () => {
  let tail;
  const mock = fixture({ onSend(socket, event) {
    if (event.type === 'session.finish') tail(socket);
  } }), cues = [];
  const session = await createLiveTranslator(config, mock).open({ start: 100, onCue: cue => cues.push(cue) });
  await session.append(input());
  const [socket] = mock.sockets;
  source(socket, 'src');
  socket.event({ type: 'conversation.item.created', previous_item_id: 'src', item: { id: 'out', role: 'assistant' } });
  socket.event({ type: 'response.text.delta', response_id: 'resp_out', item_id: 'out', delta: '现在' });
  socket.event({ type: 'response.text.delta', response_id: 'resp_out', item_id: 'out', delta: '进站。' });
  socket.event({ type: 'response.text.done', response_id: 'resp_out', item_id: 'out', text: '现在进站。' });
  assert.equal(cues.length, 0);
  tail = s => response(s, 'out', '现在进站。');
  const result = await session.finish();
  assert.equal(cues.length, 1);
  assert.equal(result.cues[0].zh, '现在进站。');
});

test('incomplete, failed and cancelled responses never become captions', async () => {
  const mock = fixture(), cues = [];
  const session = await createLiveTranslator(config, mock).open({ start: 100, onCue: c => cues.push(c) });
  await session.append(input());
  const [socket] = mock.sockets;
  source(socket, 'src');
  for (const status of ['incomplete', 'failed', 'cancelled']) {
    socket.event({ type: 'response.text.done', response_id: `resp_${status}`, item_id: status, text: '不得显示' });
    translation(socket, status, 'src', '不得显示', status);
  }
  assert.deepEqual((await session.finish()).cues, []);
  assert.deepEqual(cues, []);
});

test('noncontinuous audio, invalid PCM and oversized chunks reject without consuming program time', async () => {
  const mock = fixture();
  const session = await createLiveTranslator(config, mock).open({ start: 100 });
  await session.append(input());
  for (const chunk of [input(102), input(100), input(101, 30.1), { ...input(101), sampleRate: 8000 },
    { ...input(101), audioBase64: 'YQ==' }]) {
    await assert.rejects(session.append(chunk), { code: 'ASR_INVALID_AUDIO' });
  }
  await session.append(input(101));
  assert.equal((await session.finish()).diagnostics.audioMs, 2000);
});

test('queued append operations remain ordered and the 180 second audio budget is enforced', async () => {
  const mock = fixture();
  const session = await createLiveTranslator(config, mock).open({ start: 0 });
  const chunks = Array.from({ length: 6 }, (_, index) => session.append(input(index * 30, 30)));
  await assert.rejects(session.append(input(180)), { code: 'ASR_INVALID_AUDIO' });
  await Promise.all(chunks);
  const result = await session.finish();
  assert.equal(result.diagnostics.sentAudioMs, 180000);
  assert.equal(mock.sockets[0].frames.filter(e => e.audio).length, 1800);
});

test('cancel immediately releases a stalled write and ignores later final events', async () => {
  const mock = fixture({ holdAudio: true }), cues = [];
  const session = await createLiveTranslator(config, mock).open({ start: 100, onCue: c => cues.push(c) });
  const sending = session.append(input());
  await new Promise(resolve => setImmediate(resolve));
  session.cancel();
  await assert.rejects(sending, { code: 'CANCELLED' });
  await assert.rejects(session.done, { code: 'CANCELLED' });
  const [socket] = mock.sockets;
  source(socket, 'src', { end: 100 });
  translation(socket, 'out', 'src', '现在进站');
  socket.emit('error', new Error(config.apiKey));
  assert.deepEqual(cues, []);
  assert.equal(socket.terminated, true);
});

test('abort before opening and during connection rejects safely without an unhandled done rejection', async () => {
  const mock = fixture({ autoOpen: false });
  await assert.rejects(createLiveTranslator(config, mock).open({ start: 0, signal: AbortSignal.abort() }), { code: 'CANCELLED' });
  assert.equal(mock.sockets.length, 0);
  const controller = new AbortController();
  const opening = createLiveTranslator(config, mock).open({ start: 0, signal: controller.signal });
  controller.abort();
  await assert.rejects(opening, { code: 'CANCELLED' });
});

test('timestamps cannot escape already sent audio plus one frame and missing associations cannot silently succeed', async () => {
  for (const action of [
    socket => source(socket, 'src', { end: 1101 }),
    socket => { source(socket, 'src'); translation(socket, 'out', 'unrelated_source', '错误关联'); },
  ]) {
    const mock = fixture(), cues = [];
    const session = await createLiveTranslator(config, mock).open({ start: 100, onCue: c => cues.push(c) });
    await session.append(input());
    action(mock.sockets[0]);
    await assert.rejects(session.finish(), { code: 'ASR_INVALID_RESPONSE' });
    assert.deepEqual(cues, []);
  }
});

test('connection, send and finish timeouts are safe and abnormal close is never success', async () => {
  const connect = fixture({ autoOpen: false });
  await assert.rejects(createLiveTranslator({ ...config, timeoutMs: 50 }, connect).open({ start: 100 }), { code: 'ASR_CONNECT_TIMEOUT' });
  for (const [options, code] of [[{ holdAudio: true }, 'ASR_SEND_TIMEOUT'], [{ autoFinish: false }, 'ASR_FINISH_TIMEOUT']]) {
    const mock = fixture(options);
    const session = await createLiveTranslator({ ...config, timeoutMs: 50 }, mock).open({ start: 100 });
    if (options.holdAudio) await assert.rejects(session.append(input()), { code });
    else { await session.append(input()); await assert.rejects(session.finish(), { code }); }
    await assert.rejects(session.done, error => error.code === code && !JSON.stringify(error).includes(config.apiKey));
  }
  const mock = fixture();
  const session = await createLiveTranslator(config, mock).open({ start: 100 });
  mock.sockets[0].close();
  await assert.rejects(session.done, { code: 'ASR_CONNECTION_CLOSED' });
});

test('provider authentication errors, malformed payloads and text bounds reveal only safe error codes', async () => {
  for (const action of [
    socket => socket.event({ type: 'error', error: { code: 'InvalidApiKey', message: config.apiKey } }),
    socket => socket.emit('message', Buffer.from('not JSON: ' + config.apiKey), false),
    socket => socket.event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'src', delta: 'x'.repeat(12001) }),
  ]) {
    const mock = fixture();
    const session = await createLiveTranslator(config, mock).open({ start: 100 });
    action(mock.sockets[0]);
    await assert.rejects(session.done, error => {
      assert.ok(['ASR_AUTH_FAILED', 'ASR_INVALID_RESPONSE'].includes(error.code));
      assert.equal(error.message, error.code);
      assert.equal(JSON.stringify(error).includes(config.apiKey), false);
      return true;
    });
  }
});
