import { MOCK_TRANSLATIONS } from './glossary.mjs';
import { promptForCue, translationInput } from './translation-prompt.mjs';

export class TranslationError extends Error {
  constructor(code, status = 502) {
    super(code);
    this.name = 'TranslationError';
    this.code = code;
    this.status = status;
  }
}

export function readConfig(env = process.env) {
  const mode = env.TRANSLATION_MODE || 'mock';
  const timeoutMs = Number(env.API_TIMEOUT_MS || 8000);
  const thinking = env.API_THINKING ?? '';
  if (!['mock', 'api'].includes(mode) || !Number.isFinite(timeoutMs) || timeoutMs < 50 || timeoutMs > 60000 ||
      !['', 'disabled', 'enabled'].includes(thinking)) {
    throw new TranslationError('INVALID_CONFIG', 500);
  }
  const config = { mode, timeoutMs, endpoint: env.API_ENDPOINT, model: env.API_MODEL, key: env.API_KEY, thinking };
  if (mode === 'api') {
    let url;
    try { url = new URL(config.endpoint); } catch { throw new TranslationError('INVALID_CONFIG', 500); }
    const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if ((!localHttp && url.protocol !== 'https:') || url.username || url.password || url.hash || !config.model || !config.key) {
      throw new TranslationError('INVALID_CONFIG', 500);
    }
  }
  return config;
}

export function validateRequest(input) {
  const cue = input?.cue;
  if (!cue || typeof cue.id !== 'string' || !cue.id || cue.id.length > 200 ||
      typeof cue.text !== 'string' || !cue.text.trim() || cue.text.length > 1500 ||
      !Number.isFinite(cue.start) || cue.start < 0 || !Number.isFinite(cue.end) || cue.end <= cue.start) {
    throw new TranslationError('INVALID_CUE', 400);
  }
  const context = input.context ?? [];
  if (!Array.isArray(context) || context.length > 6 || context.some(item =>
    typeof item?.text !== 'string' || item.text.length > 1500 ||
    (item.position !== undefined && !['before', 'after'].includes(item.position)) ||
    ((item.start !== undefined || item.end !== undefined) &&
      (!Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < 0 || item.end <= item.start)))) {
    throw new TranslationError('INVALID_CONTEXT', 400);
  }
  return { cue, context };
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new TranslationError('CANCELLED', 499));
    const aborted = () => { clearTimeout(timer); reject(new TranslationError('CANCELLED', 499)); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, ms);
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

export function createTranslator(config = readConfig(), { fetchImpl = globalThis.fetch } = {}) {
  const mode = config.mode ?? 'mock';
  const timeoutMs = config.timeoutMs ?? 8000;
  return {
    mode,
    async translate(input, { signal } = {}) {
      const { cue, context } = validateRequest(input);
      if (mode === 'mock') {
        const ms = Number(input.mockDelayMs ?? 80);
        if (!Number.isFinite(ms) || ms < 0 || ms > 30000) throw new TranslationError('INVALID_MOCK_DELAY', 400);
        await pause(ms, signal);
        if (input.mockFail) throw new TranslationError('MOCK_FAILURE', 502);
        return { text: MOCK_TRANSLATIONS[cue.text.trim()] || `[模拟译文] ${cue.text.trim()}` };
      }

      const controller = new AbortController();
      let timedOut = false;
      let rejectAbort;
      const aborted = new Promise((_, reject) => { rejectAbort = reject; });
      const onAbort = () => {
        controller.abort();
        rejectAbort(new TranslationError('CANCELLED', 499));
      };
      if (signal?.aborted) throw new TranslationError('CANCELLED', 499);
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        rejectAbort(new TranslationError('TRANSLATION_TIMEOUT', 504));
      }, timeoutMs);
      const task = async () => {
        const response = await fetchImpl(config.endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.key}` },
          signal: controller.signal,
          body: JSON.stringify({
            model: config.model,
            stream: false,
            ...(config.thinking ? { thinking: { type: config.thinking } } : {}),
            messages: [
              { role: 'system', content: promptForCue(cue) },
              { role: 'user', content: JSON.stringify(translationInput(cue, context)) },
            ],
          }),
        });
        if (!response.ok) {
          try { await response.body?.cancel(); } catch { /* Keep the original provider error code. */ }
          if (response.status === 401 || response.status === 403) throw new TranslationError('UPSTREAM_AUTH_FAILED', 502);
          if (response.status === 402) throw new TranslationError('UPSTREAM_BALANCE', 502);
          if (response.status === 429) throw new TranslationError('UPSTREAM_RATE_LIMITED', 503);
          if (response.status >= 500 && response.status < 600) throw new TranslationError('UPSTREAM_UNAVAILABLE', 502);
          throw new TranslationError('UPSTREAM_REJECTED', 502);
        }
        // Bound the response too; never echo upstream bodies or provider errors.
        const reader = response.body?.getReader();
        let raw = '';
        if (reader) {
          const chunks = [];
          let size = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 65536) {
              await reader.cancel();
              throw new TranslationError('INVALID_UPSTREAM_RESPONSE', 502);
            }
            chunks.push(value);
          }
          raw = Buffer.concat(chunks).toString('utf8');
        } else raw = await response.text();
        const data = JSON.parse(raw);
        const text = data?.choices?.[0]?.message?.content;
        if (typeof text !== 'string' || !text.trim() || text.length > 3000) throw new TranslationError('INVALID_UPSTREAM_RESPONSE', 502);
        return { text: text.trim() };
      };
      try {
        return await Promise.race([task(), aborted]);
      } catch (error) {
        if (timedOut) throw new TranslationError('TRANSLATION_TIMEOUT', 504);
        if (signal?.aborted) throw new TranslationError('CANCELLED', 499);
        if (error instanceof TranslationError) throw error;
        throw new TranslationError('UPSTREAM_UNAVAILABLE', 502);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}
