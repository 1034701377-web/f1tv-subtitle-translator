const pageRequests = new Map();
let pagePreferences = {};
const postPage = message => window.postMessage({ f1zhPage: 1, ...message }, location.origin);
function pageRequest(method, payload = {}, { signal, onCue, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(Error('CANCELLED'), { code: 'CANCELLED' }));
    const id = crypto.randomUUID();
    const finish = (error, value) => {
      const request = pageRequests.get(id);
      if (!request) return;
      pageRequests.delete(id); clearTimeout(request.timer); signal?.removeEventListener('abort', abort);
      if (error) { postPage({ type: 'api-cancel', id }); reject(Object.assign(Error(error.code), error)); }
      else resolve(value);
    };
    const abort = () => finish({ code: 'CANCELLED' });
    const timer = setTimeout(() => finish({ code: 'EXTENSION_TIMEOUT' }), method === 'asr' ? 125000 : 65000);
    pageRequests.set(id, { finish, timer, onCue, onProgress });
    signal?.addEventListener('abort', abort, { once: true });
    postPage({ type: 'api-request', id, method, payload });
  });
}
window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== location.origin || event.data?.f1zhExtension !== 1) return;
  const message = event.data, pending = pageRequests.get(message.id);
  if (message.type !== 'api-response' || !pending) return;
  if (message.kind === 'cue') pending.onCue?.(message.cue);
  else if (message.kind === 'progress') pending.onProgress?.(message.diagnostics);
  else pending.finish(message.error, message.value);
});
window.addEventListener('pagehide', () => {
  for (const request of [...pageRequests.values()]) request.finish({ code: 'CANCELLED' });
});
const getPreference = (key, fallback) => pagePreferences[key] ?? fallback;
function setPreference(key, value) {
  pagePreferences[key] = value;
  void pageRequest('preference', { key, value }).catch(() => {});
}
