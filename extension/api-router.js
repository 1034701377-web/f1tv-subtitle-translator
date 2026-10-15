import { publicSettings } from './settings-store.js';
import { translateDirect, transcribeDirect } from './model-services.js';

const preferenceKeys = new Set(['subtitleTransparency', 'subtitleStyle', 'subtitlePosition', 'collectorConsole', 'floatingConsole']);
export async function providerHealth() {
  const config = await publicSettings();
  return { service: 'f1tv-zh', version: chrome.runtime.getManifest().version,
    configured: config.translation.configured, mode: 'api', asr: config.asr.enabled && config.asr.configured, radio: false };
}
export function safeApiError(error) {
  const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code) ? error.code : 'REQUEST_FAILED';
  const diagnostics = {};
  if (['connecting', 'starting', 'sending', 'recognizing'].includes(error?.diagnostics?.stage)) diagnostics.stage = error.diagnostics.stage;
  for (const key of ['elapsedMs', 'audioMs', 'sentAudioMs', 'resultEvents', 'finalSentences', 'lastResultMs']) {
    const value = error?.diagnostics?.[key];
    if (Number.isFinite(value) && value >= 0) diagnostics[key] = value;
  }
  return { code, ...(Object.keys(diagnostics).length ? { diagnostics } : {}) };
}
export function installApiRouter({ ensureOffscreen } = {}) {
  const active = new Map();
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'f1zh-api') return;
    const sender = port.sender;
    const fromPage = sender?.id === chrome.runtime.id && sender.frameId === 0
      && sender.tab && sender.url?.startsWith('https://f1tv.formula1.com/');
    const fromExtension = sender?.id === chrome.runtime.id
      && ['offscreen.html', 'options.html', 'popup.html'].some(file => sender.url === chrome.runtime.getURL(file));
    if (!fromPage && !fromExtension) { port.disconnect(); return; }
    const owner = fromPage ? sender.tab.id : sender.url;
    if ((active.get(owner) || 0) >= 8) {
      port.postMessage({ type: 'error', error: { code: 'BUSY' } }); port.disconnect(); return;
    }
    active.set(owner, (active.get(owner) || 0) + 1);
    const controller = new AbortController();
    let started = false, closed = false;
    const close = () => {
      if (closed) return;
      closed = true; controller.abort();
      const count = (active.get(owner) || 1) - 1;
      count ? active.set(owner, count) : active.delete(owner);
    };
    const post = value => { if (!closed) { try { port.postMessage(value); } catch { close(); } } };
    port.onDisconnect.addListener(close);
    port.onMessage.addListener(message => {
      if (started || closed) return;
      started = true;
      const run = async () => {
        if (JSON.stringify(message).length > 1400000) throw { code: 'INVALID_REQUEST' };
        const { method, payload } = message;
        if (method === 'health') return providerHealth();
        if (method === 'bootstrap' && fromPage) {
          const stored = (await chrome.storage.local.get('preferences')).preferences || {};
          const preferences = Object.fromEntries(Object.entries(stored).filter(([key]) => preferenceKeys.has(key)));
          return { preferences, version: chrome.runtime.getManifest().version, health: await providerHealth() };
        }
        if (method === 'preference' && fromPage) {
          if (!preferenceKeys.has(payload?.key) || JSON.stringify(payload).length > 4000) throw { code: 'INVALID_PREFERENCE' };
          const preferences = (await chrome.storage.local.get('preferences')).preferences || {};
          await chrome.storage.local.set({ preferences: { ...preferences, [payload.key]: payload.value } });
          return { ok: true };
        }
        if (method === 'open-settings' && fromPage) { await chrome.runtime.openOptionsPage(); return { ok: true }; }
        if (method === 'translate') return translateDirect(payload, { signal: controller.signal });
        if (method === 'asr') {
          await ensureOffscreen();
          if (controller.signal.aborted) throw { code: 'ABORTED' };
          return transcribeDirect(payload, { signal: controller.signal,
            onCue: cue => post({ type: 'cue', cue }), onProgress: diagnostics => post({ type: 'progress', diagnostics }) });
        }
        throw { code: 'INVALID_METHOD' };
      };
      void run().then(value => post({ type: 'result', value }), error => post({ type: 'error', error: safeApiError(error) }));
    });
  });
}
