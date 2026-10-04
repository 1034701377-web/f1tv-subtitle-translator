import WebSocket from 'ws';
import { AsrError } from './qwen-asr.mjs';

const RATE = 16000, BYTES_PER_SECOND = RATE * 2, FRAME_BYTES = BYTES_PER_SECOND / 10;
const MAX_AUDIO_SECONDS = 180, MAX_MESSAGE_BYTES = 65536, MAX_TEXT_BYTES = 262144;
const MAX_ITEMS = 1024, MAX_EVENTS = 20000;

function checkedConfig(config) {
  if (!config) return null;
  let url;
  try { url = new URL(config.endpoint); } catch { throw new AsrError('ASR_INVALID_CONFIG', 500); }
  const timeoutMs = config.timeoutMs ?? 25000;
  if (url.protocol !== 'wss:' || url.username || url.password || url.hash || url.search ||
      typeof config.apiKey !== 'string' || !config.apiKey.trim() || /[\r\n]/.test(config.apiKey) ||
      !['qwen3.8-livetranslate-flash-realtime', 'qwen3.5-livetranslate-flash-realtime'].includes(config.model) ||
      !Number.isFinite(timeoutMs) || timeoutMs < 50 || timeoutMs > 120000) {
    throw new AsrError('ASR_INVALID_CONFIG', 500);
  }
  url.pathname = '/api-ws/v1/realtime';
  url.searchParams.set('model', config.model);
  return { endpoint: url.href, model: config.model, apiKey: config.apiKey.trim(), timeoutMs };
}

function checkedAudio(input) {
  const encoded = input?.audioBase64;
  if (input?.sampleRate !== RATE || !Number.isFinite(input?.start) || input.start < 0 || input.start > 1e9 ||
      typeof encoded !== 'string' || !encoded || encoded.length > BYTES_PER_SECOND * 30 / 3 * 4 ||
      encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new AsrError('ASR_INVALID_AUDIO', 400);
  const pcm = Buffer.from(encoded, 'base64');
  if (!pcm.length || pcm.length % 2 || pcm.length > BYTES_PER_SECOND * 30 || pcm.toString('base64') !== encoded) {
    throw new AsrError('ASR_INVALID_AUDIO', 400);
  }
  return pcm;
}

function upstreamError(code) {
  const name = String(code ?? '').toLowerCase();
  if (/unauthor|authentication|invalid.?api.?key|access.?denied|^40[13]$/.test(name)) return new AsrError('ASR_AUTH_FAILED');
  if (/throttl|rate.?limit|^429$/.test(name)) return new AsrError('ASR_RATE_LIMITED', 503);
  if (/quota|balance|arrear|^402$/.test(name)) return new AsrError('ASR_BALANCE');
  return new AsrError('ASR_UPSTREAM_FAILED');
}

function checkedId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new AsrError('ASR_INVALID_RESPONSE');
  return id;
}

export function createLiveTranslator(config, { WebSocketImpl = WebSocket, pace = 1 } = {}) {
  const settings = checkedConfig(config);
  const is35 = settings?.model === 'qwen3.5-livetranslate-flash-realtime';
  if (!Number.isFinite(pace) || pace <= 0 || pace > 1000) throw new AsrError('ASR_INVALID_CONFIG', 500);
  return {
    configured: Boolean(settings),
    async open({ start, onCue, onProgress, signal } = {}) {
      if (!settings) throw new AsrError('ASR_NOT_CONFIGURED', 503);
      if (!Number.isFinite(start) || start < 0 || start > 1e9) throw new AsrError('ASR_INVALID_AUDIO', 400);
      if (signal?.aborted) throw new AsrError('CANCELLED', 499);

      let resolveOpen, rejectOpen, resolveDone, rejectDone;
      const opened = new Promise((resolve, reject) => { resolveOpen = resolve; rejectOpen = reject; });
      const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
      // A failure may precede the caller obtaining the session or awaiting done.
      void done.catch(() => {});
      let socket, settled = false, ready = false, finishRequested = false, finishSent = false, failure;
      let queuedBytes = 0, sentBytes = 0, eventCount = 0, textBytes = 0, resultEvents = 0, lastResultMs = null;
      let stage = 'connecting', timer, closeTimer, nextSendAt = 0, appendTail = Promise.resolve();
      const beganAt = Date.now(), timings = {}, sources = new Map(), outputs = new Map(), responses = new Map();
      const cues = new Map(), pending = new Set(), usage = {};
      const diagnostics = () => ({ stage, elapsedMs: Date.now() - beganAt,
        audioMs: queuedBytes / BYTES_PER_SECOND * 1000, sentAudioMs: sentBytes / BYTES_PER_SECOND * 1000,
        resultEvents, finalSentences: cues.size, lastResultMs, ...timings });
      const progress = (next, milestone) => {
        if (settled) return;
        stage = next;
        if (milestone && timings[milestone] === undefined) timings[milestone] = Date.now() - beganAt;
        try { onProgress?.(diagnostics()); } catch { complete(new AsrError('ASR_CALLBACK_FAILED')); }
      };
      const timeoutCodes = { connecting: 'ASR_CONNECT_TIMEOUT', starting: 'ASR_START_TIMEOUT',
        sending: 'ASR_SEND_TIMEOUT', recognizing: 'ASR_FINISH_TIMEOUT' };
      const armTimeout = () => {
        clearTimeout(timer);
        if (!settled) timer = setTimeout(() => complete(new AsrError(timeoutCodes[stage], 504)), settings.timeoutMs);
      };
      const hardTimer = setTimeout(() => complete(new AsrError('ASR_FINISH_TIMEOUT', 504)),
        MAX_AUDIO_SECONDS * 1000 / pace + settings.timeoutMs * 2 + 1000);
      const onAbort = () => complete(new AsrError('CANCELLED', 499));

      function complete(error) {
        if (settled) return;
        settled = true;
        failure = error;
        clearTimeout(timer);
        clearTimeout(hardTimer);
        signal?.removeEventListener('abort', onAbort);
        for (const stop of [...pending]) stop(error ?? new AsrError('ASR_CONNECTION_CLOSED'));
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
          } catch { /* Never expose provider transport errors. */ }
        }
        if (error) {
          error.diagnostics = diagnostics();
          rejectOpen(error);
          rejectDone(error);
        } else {
          resolveDone({ cues: [...cues.values()].sort((a, b) => a.start - b.start || a.end - b.end),
            usage: { ...usage }, diagnostics: diagnostics() });
        }
      }

      const send = event => new Promise((resolve, reject) => {
        if (settled || socket.readyState !== 1) return reject(failure ?? new AsrError('ASR_CONNECTION_CLOSED'));
        const stop = error => { pending.delete(stop); reject(error); };
        pending.add(stop);
        try {
          socket.send(JSON.stringify(event), { binary: false }, error => {
            if (!pending.delete(stop)) return;
            if (error) reject(new AsrError('ASR_UPSTREAM_FAILED'));
            else { armTimeout(); resolve(); }
          });
        } catch { stop(new AsrError('ASR_UPSTREAM_FAILED')); }
      });
      const pause = ms => new Promise((resolve, reject) => {
        if (settled) return reject(failure ?? new AsrError('ASR_CONNECTION_CLOSED'));
        if (ms <= 0) return resolve();
        const stop = error => { clearTimeout(waitTimer); pending.delete(stop); reject(error); };
        const waitTimer = setTimeout(() => { pending.delete(stop); resolve(); }, ms);
        pending.add(stop);
      });
      function record(map, id) {
        checkedId(id);
        if (!map.has(id)) {
          if (map.size >= MAX_ITEMS) throw new AsrError('ASR_INVALID_RESPONSE');
          map.set(id, { id });
        }
        return map.get(id);
      }
      function putText(item, field, text, append = false) {
        if (typeof text !== 'string') throw new AsrError('ASR_INVALID_RESPONSE');
        const next = append ? (item[field] ?? '') + text : text;
        if (next.length > 12000) throw new AsrError('ASR_INVALID_RESPONSE');
        textBytes += Buffer.byteLength(next) - Buffer.byteLength(item[field] ?? '');
        if (textBytes > MAX_TEXT_BYTES) throw new AsrError('ASR_INVALID_RESPONSE');
        item[field] = next;
      }
      function timestamp(ms) {
        if (!Number.isInteger(ms) || ms < 0 || ms > sentBytes / BYTES_PER_SECOND * 1000 + 100) {
          throw new AsrError('ASR_INVALID_RESPONSE');
        }
        return ms;
      }
      function publish() {
        for (const output of outputs.values()) {
          if (settled || output.delivered || !output.completed || !output.finalText) continue;
          const source = sources.get(output.sourceId);
          if (!source?.finalText || !Number.isInteger(source.begin) || !Number.isInteger(source.end)) continue;
          if (source.end <= source.begin) throw new AsrError('ASR_INVALID_RESPONSE');
          const text = source.text.trim(), zh = output.text.trim();
          if (!text || !zh) continue;
          const cue = Object.freeze({ id: `live:${start}:${output.id}`, text, zh,
            start: start + source.begin / 1000, end: start + source.end / 1000,
            ...(source.speaker !== undefined ? { speaker: source.speaker } : {}) });
          output.delivered = true;
          cues.set(output.id, cue);
          onCue?.(cue);
          progress(stage);
        }
      }

      const session = {
        done,
        async append(input) {
          if (settled) throw failure ?? new AsrError('ASR_CONNECTION_CLOSED');
          if (!ready || finishRequested) throw new AsrError('ASR_INVALID_AUDIO', 400);
          const pcm = checkedAudio(input);
          if (Math.abs(input.start - (start + queuedBytes / BYTES_PER_SECOND)) > 1 / RATE ||
              queuedBytes + pcm.length > BYTES_PER_SECOND * MAX_AUDIO_SECONDS) {
            throw new AsrError('ASR_INVALID_AUDIO', 400);
          }
          queuedBytes += pcm.length;
          const work = appendTail.then(async () => {
            if (settled) throw failure ?? new AsrError('ASR_CONNECTION_CLOSED');
            progress('sending');
            armTimeout();
            nextSendAt = Math.max(Date.now(), nextSendAt);
            for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
              await pause(nextSendAt - Date.now());
              const frame = pcm.subarray(offset, Math.min(offset + FRAME_BYTES, pcm.length));
              sentBytes += frame.length;
              await send({ type: 'input_audio_buffer.append', audio: frame.toString('base64') });
              nextSendAt += frame.length / BYTES_PER_SECOND * 1000 / pace;
            }
            await pause(nextSendAt - Date.now());
            progress('recognizing');
            armTimeout();
          });
          appendTail = work.catch(error => { complete(error instanceof AsrError ? error : new AsrError('ASR_UPSTREAM_FAILED')); throw failure; });
          void appendTail.catch(() => {});
          return appendTail;
        },
        finish() {
          if (!finishRequested && !settled) {
            finishRequested = true;
            void appendTail.then(async () => {
              if (settled) return;
              finishSent = true;
              progress('recognizing', 'finishSentMs');
              await send({ type: 'session.finish' });
            }).catch(error => complete(error instanceof AsrError ? error : new AsrError('ASR_UPSTREAM_FAILED')));
          }
          return done;
        },
        cancel: onAbort,
      };
      armTimeout();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        socket = new WebSocketImpl(settings.endpoint, {
          headers: { Authorization: `Bearer ${settings.apiKey}` },
          handshakeTimeout: Math.min(settings.timeoutMs, 10000), followRedirects: false,
          perMessageDeflate: false, maxPayload: MAX_MESSAGE_BYTES,
        });
        socket.on('error', () => complete(new AsrError('ASR_UPSTREAM_FAILED')));
        socket.on('close', () => { clearTimeout(closeTimer); complete(new AsrError('ASR_CONNECTION_CLOSED')); });
        socket.on('unexpected-response', (_request, response) => {
          response.destroy?.();
          complete(upstreamError(response.statusCode));
        });
        socket.on('open', () => {
          if (settled) return;
          progress('starting', 'connectedMs');
          armTimeout();
          const configuration = is35 ? { modalities: ['text'], translation: { language: 'zh' },
            input_audio_format: 'pcm', sample_rate: RATE,
            input_audio_transcription: { model: 'qwen3-asr-flash-realtime', language: 'en' },
            turn_detection: { type: 'server_vad', threshold: 0.2, silence_duration_ms: 1000 },
          } : { output_modalities: ['text'], translation: { language: 'zh' },
            audio: { input: { turn_detection: { type: 'speaker_detection', threshold: 0.5 } } } };
          void send({ type: 'session.update', session: configuration })
            .catch(error => complete(error));
        });
        socket.on('message', (raw, binary) => {
          if (settled) return;
          try {
            if (binary || Buffer.byteLength(raw) > MAX_MESSAGE_BYTES || ++eventCount > MAX_EVENTS) throw new AsrError('ASR_INVALID_RESPONSE');
            const event = JSON.parse(raw.toString());
            if (!event || typeof event.type !== 'string') throw new AsrError('ASR_INVALID_RESPONSE');
            armTimeout();
            if (event.type === 'error') return complete(upstreamError(event.error?.code ?? event.code));
            if (event.type === 'session.created') return;
            if (event.type === 'session.updated') {
              const modalities = event.session?.[is35 ? 'modalities' : 'output_modalities'];
              if (ready || !Array.isArray(modalities) || modalities.length !== 1 || modalities[0] !== 'text' ||
                  event.session.translation?.language !== 'zh' || (event.session.model && event.session.model !== settings.model)) {
                throw new AsrError('ASR_INVALID_RESPONSE');
              }
              ready = true;
              progress('recognizing', 'taskStartedMs');
              resolveOpen(session);
              return;
            }
            if (!ready) throw new AsrError('ASR_INVALID_RESPONSE');
            if (event.type === 'session.finished') {
              if (!finishSent) throw new AsrError('ASR_INVALID_RESPONSE');
              publish();
              for (const output of outputs.values()) {
                if (output.completed && output.finalText && output.text.trim() && !output.delivered) {
                  throw new AsrError('ASR_INVALID_RESPONSE');
                }
              }
              complete();
              return;
            }
            resultEvents++;
            lastResultMs = Date.now() - beganAt;
            if (resultEvents === 1) progress(stage, 'firstResultMs');
            switch (event.type) {
              case 'input_audio_buffer.speech_started': {
                const source = record(sources, event.item_id);
                const begin = timestamp(event.audio_start_ms);
                if (source.begin !== undefined && source.begin !== begin) throw new AsrError('ASR_INVALID_RESPONSE');
                source.begin = begin;
                if (event.speaker_id !== undefined) {
                  if (!Number.isInteger(event.speaker_id) || event.speaker_id < 0 || event.speaker_id > 1000000) throw new AsrError('ASR_INVALID_RESPONSE');
                  source.speaker = event.speaker_id;
                }
                break;
              }
              case 'input_audio_buffer.speech_stopped': {
                const source = record(sources, event.item_id);
                const end = timestamp(event.audio_end_ms);
                if (source.end !== undefined && source.end !== end) throw new AsrError('ASR_INVALID_RESPONSE');
                source.end = end;
                break;
              }
              case 'conversation.item.input_audio_transcription.delta': {
                if (is35) break;
                const source = record(sources, event.item_id);
                if (!source.finalText) putText(source, 'text', event.delta, true);
                break;
              }
              case 'conversation.item.input_audio_transcription.completed': {
                const source = record(sources, event.item_id);
                if (!source.finalText) { putText(source, 'text', event.transcript); source.finalText = true; }
                break;
              }
              case 'conversation.item.input_audio_transcription.failed': throw new AsrError('ASR_UPSTREAM_FAILED');
              case 'conversation.item.created': {
                // Live 3.8 also labels the input-audio item as assistant. Its
                // explicit content type identifies the source, irrespective of
                // role or event order; only translated items carry a backlink.
                if (Array.isArray(event.item?.content) && event.item.content.some(part => part.type === 'input_audio')) {
                  record(sources, event.item.id);
                  break;
                }
                if (event.item?.role !== 'assistant') break;
                const output = record(outputs, event.item.id), sourceId = checkedId(event.previous_item_id);
                if (output.sourceId && output.sourceId !== sourceId) throw new AsrError('ASR_INVALID_RESPONSE');
                output.sourceId = sourceId;
                break;
              }
              case 'response.text.delta':
              case 'response.text.done': {
                if (is35 && event.type === 'response.text.delta') break;
                const output = record(outputs, event.item_id), responseId = checkedId(event.response_id);
                if (output.responseId && output.responseId !== responseId) throw new AsrError('ASR_INVALID_RESPONSE');
                output.responseId = responseId;
                if (!output.finalText) {
                  putText(output, 'text', event.type === 'response.text.done' ? event.text : event.delta, event.type === 'response.text.delta');
                  if (event.type === 'response.text.done') output.finalText = true;
                }
                break;
              }
              // 3.5 text/stash events are provisional. Only the separate final
              // transcript and completed response may produce a frozen cue.
              case 'conversation.item.input_audio_transcription.text':
              case 'response.text.text': break;
              case 'response.done': {
                const response = event.response, state = record(responses, response?.id);
                if (state.finished) break;
                state.finished = true;
                if (!['completed', 'failed', 'incomplete', 'cancelled'].includes(response.status) ||
                    !Array.isArray(response.output) || response.output.length > 64) throw new AsrError('ASR_INVALID_RESPONSE');
                for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) {
                  const value = response.usage?.[key];
                  if (Number.isFinite(value) && value >= 0) usage[key] = (usage[key] ?? 0) + value;
                }
                for (const item of response.output) {
                  const output = record(outputs, item.id);
                  if (output.responseId && output.responseId !== response.id) throw new AsrError('ASR_INVALID_RESPONSE');
                  output.responseId = response.id;
                  output.completed = response.status === 'completed' && (!item.status || item.status === 'completed');
                  if (output.delivered) continue;
                  if (!Array.isArray(item.content) || item.content.length > 64) throw new AsrError('ASR_INVALID_RESPONSE');
                  const parts = item.content.filter(part => part.type === 'text');
                  if (parts.length) {
                    if (parts.some(part => typeof part.text !== 'string')) throw new AsrError('ASR_INVALID_RESPONSE');
                    putText(output, 'text', parts.map(part => part.text).join(''));
                    output.finalText = true;
                  }
                }
                break;
              }
              default: break; // Other bounded lifecycle events carry no captions.
            }
            publish();
          } catch (error) { complete(error instanceof AsrError ? error : new AsrError('ASR_INVALID_RESPONSE')); }
        });
      } catch { complete(new AsrError('ASR_UPSTREAM_FAILED')); }
      return opened;
    },
  };
}
