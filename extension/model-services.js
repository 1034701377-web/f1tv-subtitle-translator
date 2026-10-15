import { createTranslator, TranslationError } from '../lib/translator.mjs';
import { createBrowserAsr, cleanupBrowserAsrRules, AsrError } from './browser-asr.js';
import { loadSettings, requireHostPermission } from './settings-store.js';
import { DocumentWebSocket } from './document-websocket.js';

// The shared translator's Node reader uses Buffer. Supply an equivalent
// browser-native bounded text reader, leaving its prompt and protocol intact.
function browserFetch(fetchImpl) {
  return async (endpoint, options) => {
    const response = await fetchImpl(endpoint, { ...options, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    if (!response.ok) return response;
    const reader = response.body?.getReader();
    let text = '', size = 0;
    if (reader) {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 65536) throw new TranslationError('INVALID_UPSTREAM_RESPONSE', 502);
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } catch (error) {
        try { await reader.cancel(); } catch {}
        if (error instanceof TranslationError) throw error;
        throw new TranslationError('INVALID_UPSTREAM_RESPONSE', 502);
      } finally { reader.releaseLock(); }
    } else {
      text = await response.text();
      if (new TextEncoder().encode(text).byteLength > 65536) throw new TranslationError('INVALID_UPSTREAM_RESPONSE', 502);
    }
    return { ok: true, status: response.status, text: async () => text };
  };
}

export function createModelServices({ loadSettingsImpl = loadSettings, chromeApi = globalThis.chrome,
  fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, cryptoImpl = globalThis.crypto } = {}) {
  let translations = 0, transcribing = false;
  let asrStartup;
  const ensureAsrStartup = () => asrStartup ??= cleanupBrowserAsrRules(chromeApi).catch(error => {
    asrStartup = undefined;
    throw error;
  });
  return {
    async translateDirect(input, { signal } = {}) {
      if (signal?.aborted) throw new TranslationError('CANCELLED', 499);
      if (translations >= 4) throw new TranslationError('TRANSLATION_BUSY', 429);
      translations++;
      try {
        const { translation } = await loadSettingsImpl();
        if (!translation?.key) throw new TranslationError('TRANSLATION_NOT_CONFIGURED', 503);
        await requireHostPermission(translation.endpoint, chromeApi);
        return await createTranslator(translation, { fetchImpl: browserFetch(fetchImpl) }).translate(input, { signal });
      } finally { translations--; }
    },
    async transcribeDirect(input, { signal, onCue, onProgress } = {}) {
      if (signal?.aborted) throw new AsrError('CANCELLED', 499);
      if (transcribing) throw new AsrError('ASR_BUSY', 409);
      transcribing = true;
      try {
        const { asr } = await loadSettingsImpl();
        if (!asr?.enabled || !asr.endpoint || !asr.apiKey) throw new AsrError('ASR_NOT_CONFIGURED', 503);
        // This service worker is the only ASR owner. Finish startup cleanup
        // before the first request installs a rule, then never repeat it while
        // later requests are running. A failed cleanup remains a visible error.
        await ensureAsrStartup();
        return await createBrowserAsr(asr, { chromeApi, WebSocketImpl, cryptoImpl }).transcribe(input, { signal, onCue, onProgress });
      } finally { transcribing = false; }
    },
  };
}

let services;
const direct = () => services ??= createModelServices({ WebSocketImpl: DocumentWebSocket });
export const translateDirect = (input, options) => direct().translateDirect(input, options);
export const transcribeDirect = (input, options) => direct().transcribeDirect(input, options);
