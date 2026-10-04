import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const SAMPLE_RATE = 16000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
const MAX_AUDIO_BYTES = BYTES_PER_SECOND * 30;
const FRAME_BYTES = BYTES_PER_SECOND / 10;
const MAX_RESPONSE_BYTES = 65536;

export class AsrError extends Error {
  constructor(code, status = 502) {
    super(code);
    this.name = 'AsrError';
    this.code = code;
    this.status = status;
  }
}

function checkedConfig(config) {
  let url;
  try { url = new URL(config.endpoint); } catch { throw new AsrError('ASR_INVALID_CONFIG', 500); }
  const timeoutMs = config.timeoutMs ?? 25000;
  if (url.protocol !== 'wss:' || url.username || url.password || url.hash || url.search ||
      typeof config.apiKey !== 'string' || !config.apiKey.trim() || /[\r\n]/.test(config.apiKey) ||
      typeof config.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(config.model) ||
      !Number.isFinite(timeoutMs) || timeoutMs < 50 || timeoutMs > 120000) {
    throw new AsrError('ASR_INVALID_CONFIG', 500);
  }
  return { endpoint: url.href, apiKey: config.apiKey.trim(), model: config.model, timeoutMs };
}

export function readAsrConfig(env = process.env) {
  // A shared DashScope key alone must not enable ASR for caption-only users.
  if (!env.ASR_ENDPOINT && !env.ASR_MODEL) return null;
  return checkedConfig({
    endpoint: env.ASR_ENDPOINT,
    model: env.ASR_MODEL,
    apiKey: env.DASHSCOPE_API_KEY,
    timeoutMs: Number(env.ASR_TIMEOUT_MS || 25000),
  });
}

function audioInput(input) {
  const encoded = input?.audioBase64;
  if (input?.sampleRate !== SAMPLE_RATE || !Number.isFinite(input?.start) || input.start < 0 || input.start > 1e9 ||
      typeof encoded !== 'string' || !encoded || encoded.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4 ||
      encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new AsrError('ASR_INVALID_AUDIO', 400);
  }
  const pcm = Buffer.from(encoded, 'base64');
  if (!pcm.length || pcm.length % 2 !== 0 || pcm.length > MAX_AUDIO_BYTES || pcm.toString('base64') !== encoded) {
    throw new AsrError('ASR_INVALID_AUDIO', 400);
  }
  return { pcm, start: input.start, durationMs: pcm.length / BYTES_PER_SECOND * 1000 };
}

function safeUsage(value) {
  const usage = {};
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens', 'duration']) {
    if (Number.isFinite(value?.[key]) && value[key] >= 0) usage[key] = value[key];
  }
  return usage;
}

function timedSentenceParts(sentence, begin, end, text) {
  const words = sentence.words;
  if (!Array.isArray(words) || !words.length || words.length > 2000) return null;
  const normalize = value => value.replace(/\s+/gu, ' ').trim();
  let previousEnd = begin, combined = '';
  for (const word of words) {
    if (!word || word.fixed !== true || typeof word.text !== 'string' || !word.text ||
        typeof word.punctuation !== 'string' || !Number.isInteger(word.begin_time) || !Number.isInteger(word.end_time) ||
        word.begin_time < previousEnd || word.end_time <= word.begin_time || word.end_time > end) return null;
    combined += word.text + word.punctuation;
    if (combined.length > 12000) return null;
    previousEnd = word.end_time;
  }
  // Tokens may contain leading spaces and apostrophe fragments. Inserting a
  // separator between tokens would change the source and fail this check.
  if (normalize(combined) !== normalize(text)) return null;
  const parts = [];
  let first = 0, partText = '';
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    partText += word.text + word.punctuation;
    // Only the provider's punctuation field is a sentence boundary. Dots
    // inside a word (abbreviations or decimals) never create a split.
    if (/[.!?。！？]/u.test(word.punctuation) || i === words.length - 1) {
      const finalText = normalize(partText);
      if (!finalText) return null;
      parts.push({ text: finalText, begin: words[first].begin_time, end: word.end_time });
      first = i + 1;
      partText = '';
    }
  }
  return parts;
}

function upstreamError(code) {
  const name = String(code ?? '').toLowerCase();
  if (/unauthor|authentication|invalid.?api.?key|access.?denied|^40[13]$/.test(name)) return new AsrError('ASR_AUTH_FAILED');
  if (/throttl|rate.?limit|^429$/.test(name)) return new AsrError('ASR_RATE_LIMITED', 503);
  if (/quota|balance|arrear|^402$/.test(name)) return new AsrError('ASR_BALANCE');
  return new AsrError('ASR_UPSTREAM_FAILED');
}

export function createAsr(config = readAsrConfig(), { WebSocketImpl = WebSocket } = {}) {
  const settings = config ? checkedConfig(config) : null;
  return {
    configured: Boolean(settings),
    async transcribe(input, { signal, onCue, onProgress } = {}) {
      const { pcm, start, durationMs } = audioInput(input);
      if (!settings) throw new AsrError('ASR_NOT_CONFIGURED', 503);
      if (signal?.aborted) throw new AsrError('CANCELLED', 499);

      return new Promise((resolve, reject) => {
        const taskId = randomUUID();
        const sentences = new Map();
        const finalizedSentenceIds = new Set();
        let usage = {};
        let socket;
        let settled = false;
        let started = false;
        let finishSent = false;
        let textBytes = 0;
        let closeTimer;
        const beganAt = Date.now();
        let stage = 'connecting', sentAudioMs = 0, resultEvents = 0, lastResultMs = null;
        const timings = {};
        const diagnostics = () => ({ stage, elapsedMs: Date.now() - beganAt, audioMs: durationMs,
          sentAudioMs, resultEvents, finalSentences: sentences.size, lastResultMs, ...timings });
        const progress = (next, milestone) => {
          stage = next;
          if (milestone) timings[milestone] = Date.now() - beganAt;
          onProgress?.(diagnostics());
        };

        const finish = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          // Keep the error listener attached: closing a CONNECTING ws can emit
          // an asynchronous error. Never pass that provider error to callers.
          if (socket && socket.readyState !== 3) {
            try {
              if (error) socket.terminate();
              else {
                socket.close(1000);
                if (socket.readyState !== 3) {
                  closeTimer = setTimeout(() => socket.terminate(), 1000);
                  closeTimer.unref?.();
                }
              }
            } catch { /* Completion must not expose transport details. */ }
          }
          if (error) { error.diagnostics = diagnostics(); reject(error); }
          else resolve({ cues: [...sentences.values()].sort((a, b) => a.start - b.start || a.end - b.end), usage });
        };
        const onAbort = () => finish(new AsrError('CANCELLED', 499));
        const timeoutCodes = { connecting: 'ASR_CONNECT_TIMEOUT', starting: 'ASR_START_TIMEOUT',
          sending: 'ASR_SEND_TIMEOUT', recognizing: 'ASR_FINISH_TIMEOUT' };
        const timer = setTimeout(() => finish(new AsrError(timeoutCodes[stage], 504)), settings.timeoutMs);
        signal?.addEventListener('abort', onAbort, { once: true });

        const send = (data, binary = false) => new Promise((sent, failed) => {
          if (settled || socket.readyState !== 1) return failed(new AsrError('ASR_CONNECTION_CLOSED'));
          try {
            socket.send(data, { binary }, error => error ? failed(new AsrError('ASR_UPSTREAM_FAILED')) : sent());
          } catch { failed(new AsrError('ASR_UPSTREAM_FAILED')); }
        });
        const command = (action, payload) => JSON.stringify({ header: { action, task_id: taskId, streaming: 'duplex' }, payload });
        const sendAudio = async () => {
          try {
            // Await each write completion: at most one 100 ms frame is queued.
            // No real-time sleeps; a buffered replay can be processed promptly.
            for (let offset = 0; offset < pcm.length && !settled; offset += FRAME_BYTES) {
              await send(pcm.subarray(offset, Math.min(offset + FRAME_BYTES, pcm.length)), true);
              sentAudioMs = Math.min(offset + FRAME_BYTES, pcm.length) / BYTES_PER_SECOND * 1000;
            }
            if (settled) return;
            finishSent = true;
            await send(command('finish-task', { input: {} }));
            if (!settled) progress('recognizing', 'finishSentMs');
          } catch (error) { finish(error instanceof AsrError ? error : new AsrError('ASR_UPSTREAM_FAILED')); }
        };

        try {
          socket = new WebSocketImpl(settings.endpoint, {
            headers: { Authorization: `Bearer ${settings.apiKey}` },
            handshakeTimeout: Math.min(settings.timeoutMs, 10000),
            followRedirects: false,
            perMessageDeflate: false,
            maxPayload: MAX_RESPONSE_BYTES,
          });
          socket.on('error', () => finish(new AsrError('ASR_UPSTREAM_FAILED')));
          socket.on('close', () => {
            clearTimeout(closeTimer);
            finish(new AsrError('ASR_CONNECTION_CLOSED'));
          });
          socket.on('unexpected-response', (_request, response) => {
            response.destroy?.();
            finish(upstreamError(response.statusCode));
          });
          socket.on('open', () => {
            if (settled) return;
            progress('starting', 'connectedMs');
            void send(command('run-task', {
              task_group: 'audio', task: 'asr', function: 'recognition', model: settings.model,
              // Omit language_hints to let the provider detect supported languages.
              // https://help.aliyun.com/zh/model-studio/qwen-audio-asr-streaming-client-events
              parameters: { format: 'pcm', sample_rate: SAMPLE_RATE,
                semantic_punctuation_enabled: false, max_sentence_silence: 800,
                multi_threshold_mode_enabled: true }, input: {},
            })).catch(error => finish(error));
          });
          socket.on('message', (raw, isBinary) => {
            if (settled) return;
            try {
              if (isBinary || Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) throw new AsrError('ASR_INVALID_RESPONSE');
              const event = JSON.parse(raw.toString());
              if (event.header?.task_id !== taskId) throw new AsrError('ASR_INVALID_RESPONSE');
              const nextUsage = safeUsage(event.payload?.usage ?? event.payload?.output?.usage);
              if (Object.keys(nextUsage).length) usage = nextUsage; // Cumulative snapshot, never sum it.
              switch (event.header.event) {
                case 'task-started':
                  if (started) throw new AsrError('ASR_INVALID_RESPONSE');
                  started = true;
                  progress('sending', 'taskStartedMs');
                  void sendAudio();
                  break;
                case 'result-generated': {
                  if (!started) throw new AsrError('ASR_INVALID_RESPONSE');
                  resultEvents++;
                  lastResultMs = Date.now() - beganAt;
                  if (resultEvents === 1) progress(stage, 'firstResultMs');
                  const sentence = event.payload?.output?.sentence;
                  if (!sentence || sentence.heartbeat || sentence.sentence_end !== true) break;
                  if (typeof sentence.text !== 'string') throw new AsrError('ASR_INVALID_RESPONSE');
                  const text = sentence.text.trim();
                  if (!text) break;
                  const begin = sentence.begin_time;
                  const end = sentence.end_time;
                  if (text.length > 3000 || !Number.isInteger(begin) || !Number.isInteger(end) ||
                      begin < 0 || end <= begin || end > Math.ceil(durationMs)) throw new AsrError('ASR_INVALID_RESPONSE');
                  const key = Number.isInteger(sentence.sentence_id) ? sentence.sentence_id : `${begin}:${end}:${text}`;
                  // A final sentence is immutable once delivered, including if
                  // the provider sends that sentence ID again with revised text.
                  if (finalizedSentenceIds.has(key)) break;
                  const parts = timedSentenceParts(sentence, begin, end, text);
                  textBytes += Buffer.byteLength(text);
                  if (textBytes > MAX_RESPONSE_BYTES || sentences.size + (parts?.length ?? 1) > 1000) throw new AsrError('ASR_INVALID_RESPONSE');
                  finalizedSentenceIds.add(key);
                  for (const [partIndex, part] of (parts ?? [{ text, begin, end }]).entries()) {
                    if (settled) break;
                    const cue = Object.freeze({ text: part.text, start: start + part.begin / 1000, end: start + part.end / 1000,
                      ...(parts ? { id: `asr:${start}:${begin}:${end}:${Number.isInteger(sentence.sentence_id) ? sentence.sentence_id : 'time'}:part:${partIndex}` } : {}) });
                    sentences.set(JSON.stringify([key, partIndex]), cue);
                    onCue?.(cue);
                    if (!settled) progress(stage);
                  }
                  break;
                }
                case 'task-finished':
                  if (!finishSent) throw new AsrError('ASR_INVALID_RESPONSE');
                  finish();
                  break;
                case 'task-failed':
                  finish(upstreamError(event.header.error_code));
                  break;
                default: throw new AsrError('ASR_INVALID_RESPONSE');
              }
            } catch (error) { finish(error instanceof AsrError ? error : new AsrError('ASR_INVALID_RESPONSE')); }
          });
        } catch { finish(new AsrError('ASR_UPSTREAM_FAILED')); }
      });
    },
  };
}
