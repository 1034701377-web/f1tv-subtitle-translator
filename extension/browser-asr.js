import { timedSentenceParts } from '../src/asr-sentences.js';
import { checkedEndpoint, requireHostPermission } from './settings-store.js';

const SAMPLE_RATE = 16000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
const MAX_AUDIO_BYTES = BYTES_PER_SECOND * 30;
const FRAME_BYTES = BYTES_PER_SECOND / 10;
const MAX_RESPONSE_BYTES = 65536;
const MAX_BUFFERED_BYTES = 65536;
const RULE_ID_MIN = 1900000000;
const RULE_ID_COUNT = 100000;
const active = new WeakSet();
const encoder = new TextEncoder();

export class AsrError extends Error {
  constructor(code, status = 502) {
    super(code); this.name = 'AsrError'; this.code = code; this.status = status;
  }
}

function checkedConfig(config) {
  try {
    const endpoint = checkedEndpoint(config.endpoint, 'wss:');
    const timeoutMs = config.timeoutMs ?? 25000;
    if (typeof config.apiKey !== 'string' || !/^[A-Za-z0-9._~+/=:-]{1,1024}$/.test(config.apiKey) ||
        typeof config.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(config.model) ||
        !Number.isFinite(timeoutMs) || timeoutMs < 50 || timeoutMs > 120000) throw Error();
    return { endpoint, apiKey: config.apiKey, model: config.model, timeoutMs };
  } catch { throw new AsrError('ASR_INVALID_CONFIG', 500); }
}

function audioInput(input) {
  const encoded = input?.audioBase64;
  if (input?.sampleRate !== SAMPLE_RATE || !Number.isFinite(input?.start) || input.start < 0 || input.start > 1e9 ||
      typeof encoded !== 'string' || !encoded || encoded.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4 ||
      encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new AsrError('ASR_INVALID_AUDIO', 400);
  let binary;
  try { binary = atob(encoded); } catch { throw new AsrError('ASR_INVALID_AUDIO', 400); }
  if (!binary.length || binary.length % 2 !== 0 || binary.length > MAX_AUDIO_BYTES || btoa(binary) !== encoded) {
    throw new AsrError('ASR_INVALID_AUDIO', 400);
  }
  const pcm = Uint8Array.from(binary, character => character.charCodeAt(0));
  return { pcm, start: input.start, durationMs: pcm.length / BYTES_PER_SECOND * 1000 };
}

function safeUsage(value) {
  const usage = {};
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens', 'duration']) {
    if (Number.isFinite(value?.[key]) && value[key] >= 0) usage[key] = value[key];
  }
  return usage;
}

function upstreamError(code) {
  const name = String(code ?? '').toLowerCase();
  if (/unauthor|authentication|invalid.?api.?key|access.?denied|^40[13]$/.test(name)) return new AsrError('ASR_AUTH_FAILED');
  if (/throttl|rate.?limit|^429$/.test(name)) return new AsrError('ASR_RATE_LIMITED', 503);
  if (/quota|balance|arrear|^402$/.test(name)) return new AsrError('ASR_BALANCE');
  return new AsrError('ASR_UPSTREAM_FAILED');
}

// Call once when the sole ASR service worker starts, before its first request.
// This removes authorization left behind by a terminated browser context.
export async function cleanupBrowserAsrRules(chromeApi = globalThis.chrome) {
  if (active.has(chromeApi)) throw new AsrError('ASR_BUSY', 409);
  try {
    const rules = await chromeApi.declarativeNetRequest.getSessionRules();
    const ids = rules.filter(rule => rule.id >= RULE_ID_MIN && rule.id < RULE_ID_MIN + RULE_ID_COUNT).map(rule => rule.id);
    if (ids.length) await chromeApi.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
  } catch { throw new AsrError('ASR_AUTH_CLEANUP_FAILED', 500); }
}

export function createBrowserAsr(config, { chromeApi = globalThis.chrome, WebSocketImpl = globalThis.WebSocket,
  cryptoImpl = globalThis.crypto } = {}) {
  const settings = config ? checkedConfig(config) : null;
  return {
    configured: Boolean(settings),
    async transcribe(input, { signal, onCue, onProgress } = {}) {
      const audio = audioInput(input);
      if (!settings) throw new AsrError('ASR_NOT_CONFIGURED', 503);
      if (signal?.aborted) throw new AsrError('CANCELLED', 499);
      if (!chromeApi) throw new AsrError('ASR_AUTH_UNAVAILABLE', 503);
      if (active.has(chromeApi)) throw new AsrError('ASR_BUSY', 409);
      active.add(chromeApi);
      let ruleId, ruleAttempted = false;
      try {
        await requireHostPermission(settings.endpoint, chromeApi);
        if (signal?.aborted) throw new AsrError('CANCELLED', 499);
        try {
          if (!/^[a-p]{32}$/.test(chromeApi.runtime.id)) throw Error();
          const occupied = new Set((await chromeApi.declarativeNetRequest.getSessionRules()).map(rule => rule.id));
          ruleId = RULE_ID_MIN + cryptoImpl.getRandomValues(new Uint32Array(1))[0] % RULE_ID_COUNT;
          let attempts = 0;
          while (occupied.has(ruleId) && attempts++ < RULE_ID_COUNT) ruleId = RULE_ID_MIN + (ruleId - RULE_ID_MIN + 1) % RULE_ID_COUNT;
          if (occupied.has(ruleId)) throw Error();
          ruleAttempted = true;
          await chromeApi.declarativeNetRequest.updateSessionRules({ addRules: [{
            id: ruleId, priority: 1,
            action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Authorization', operation: 'set', value: `Bearer ${settings.apiKey}` }] },
            condition: { urlFilter: `|${settings.endpoint}|`, isUrlFilterCaseSensitive: true,
              initiatorDomains: [chromeApi.runtime.id], resourceTypes: ['websocket'] },
          }] });
        } catch { throw new AsrError('ASR_AUTH_UNAVAILABLE', 500); }
        if (signal?.aborted) throw new AsrError('CANCELLED', 499);
        return await runSocket(settings, audio, { signal, onCue, onProgress, WebSocketImpl, cryptoImpl });
      } finally {
        try {
          // The unique ID belongs only to this request; a late cleanup can
          // never remove another request's header rule.
          if (ruleAttempted) await chromeApi.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
        } catch { throw new AsrError('ASR_AUTH_CLEANUP_FAILED', 500); }
        finally { active.delete(chromeApi); }
      }
    },
  };
}

function runSocket(settings, { pcm, start, durationMs }, { signal, onCue, onProgress, WebSocketImpl, cryptoImpl }) {
  return new Promise((resolve, reject) => {
    const taskId = cryptoImpl.randomUUID();
    const sentences = new Map(), finalizedSentenceIds = new Set();
    let usage = {}, socket, settled = false, started = false, finishSent = false, textBytes = 0;
    let drainTimer, wakeDrain;
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
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(drainTimer); wakeDrain?.();
      signal?.removeEventListener('abort', onAbort);
      // Native WebSocket has no terminate(). Closing also cancels a pending
      // handshake; listeners intentionally remain safe for late error events.
      try { if (socket && socket.readyState < 2) socket.close(1000); } catch {}
      if (error) { error.diagnostics = diagnostics(); reject(error); }
      else resolve({ cues: [...sentences.values()].sort((a, b) => a.start - b.start || a.end - b.end), usage });
    };
    const onAbort = () => finish(new AsrError('CANCELLED', 499));
    const timeoutCodes = { connecting: 'ASR_CONNECT_TIMEOUT', starting: 'ASR_START_TIMEOUT',
      sending: 'ASR_SEND_TIMEOUT', recognizing: 'ASR_FINISH_TIMEOUT' };
    const timer = setTimeout(() => finish(new AsrError(timeoutCodes[stage], 504)), settings.timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }

    const send = async data => {
      const bytes = typeof data === 'string' ? encoder.encode(data).byteLength : data.byteLength;
      while (!settled && socket.readyState === 1 && socket.bufferedAmount + bytes > MAX_BUFFERED_BYTES) {
        await new Promise(resolve => { wakeDrain = resolve; drainTimer = setTimeout(resolve, 5); });
        wakeDrain = undefined;
      }
      if (settled || socket.readyState !== 1) throw new AsrError('ASR_CONNECTION_CLOSED');
      try { socket.send(data); } catch { throw new AsrError('ASR_UPSTREAM_FAILED'); }
    };
    const command = (action, payload) => JSON.stringify({ header: { action, task_id: taskId, streaming: 'duplex' }, payload });
    const sendAudio = async () => {
      try {
        for (let offset = 0; offset < pcm.length && !settled; offset += FRAME_BYTES) {
          await send(pcm.subarray(offset, Math.min(offset + FRAME_BYTES, pcm.length)));
          sentAudioMs = Math.min(offset + FRAME_BYTES, pcm.length) / BYTES_PER_SECOND * 1000;
        }
        if (settled) return;
        finishSent = true;
        await send(command('finish-task', { input: {} }));
        if (!settled) progress('recognizing', 'finishSentMs');
      } catch (error) { finish(error instanceof AsrError ? error : new AsrError('ASR_UPSTREAM_FAILED')); }
    };
    try {
      socket = new WebSocketImpl(settings.endpoint);
      socket.binaryType = 'arraybuffer';
      socket.addEventListener('error', () => finish(new AsrError('ASR_UPSTREAM_FAILED')));
      socket.addEventListener('close', () => finish(new AsrError('ASR_CONNECTION_CLOSED')));
      socket.addEventListener('open', () => {
        if (settled) return;
        try {
          progress('starting', 'connectedMs');
          void send(command('run-task', {
            task_group: 'audio', task: 'asr', function: 'recognition', model: settings.model,
            parameters: { format: 'pcm', sample_rate: SAMPLE_RATE, semantic_punctuation_enabled: false,
              max_sentence_silence: 800, multi_threshold_mode_enabled: true }, input: {},
          })).catch(error => finish(error));
        } catch { finish(new AsrError('ASR_UPSTREAM_FAILED')); }
      });
      socket.addEventListener('message', message => {
        if (settled) return;
        try {
          if (typeof message.data !== 'string' || message.data.length > MAX_RESPONSE_BYTES ||
              encoder.encode(message.data).byteLength > MAX_RESPONSE_BYTES) throw new AsrError('ASR_INVALID_RESPONSE');
          const event = JSON.parse(message.data);
          if (event?.header?.task_id !== taskId) throw new AsrError('ASR_INVALID_RESPONSE');
          const nextUsage = safeUsage(event.payload?.usage ?? event.payload?.output?.usage);
          if (Object.keys(nextUsage).length) usage = nextUsage;
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
              const begin = sentence.begin_time, end = sentence.end_time;
              if (text.length > 3000 || !Number.isInteger(begin) || !Number.isInteger(end) || begin < 0 ||
                  end <= begin || end > Math.ceil(durationMs)) throw new AsrError('ASR_INVALID_RESPONSE');
              const key = Number.isInteger(sentence.sentence_id) ? sentence.sentence_id : `${begin}:${end}:${text}`;
              if (finalizedSentenceIds.has(key)) break;
              const parts = timedSentenceParts(sentence, begin, end, text);
              textBytes += encoder.encode(text).byteLength;
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
            case 'task-failed': finish(upstreamError(event.header.error_code)); break;
            default: throw new AsrError('ASR_INVALID_RESPONSE');
          }
        } catch (error) { finish(error instanceof AsrError ? error : new AsrError('ASR_INVALID_RESPONSE')); }
      });
    } catch { finish(new AsrError('ASR_UPSTREAM_FAILED')); }
  });
}
