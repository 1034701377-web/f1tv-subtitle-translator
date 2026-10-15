// Long-lived ports deliver finalized ASR cues before the complete window ends.
export function extensionRequest(method, payload = {}, { signal, onCue, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(Error('CANCELLED'), { code: 'CANCELLED' }));
    let port, finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      port?.disconnect();
      error ? reject(Object.assign(Error(error.code), error)) : resolve(value);
    };
    const abort = () => finish({ code: 'CANCELLED' });
    const timer = setTimeout(() => finish({ code: 'EXTENSION_TIMEOUT' }), 125000);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      port = chrome.runtime.connect({ name: 'f1zh-api' });
      port.onMessage.addListener(message => {
        if (finished) return;
        if (message.type === 'cue') onCue?.(message.cue);
        else if (message.type === 'progress') onProgress?.(message.diagnostics);
        else if (message.type === 'result') finish(null, message.value);
        else if (message.type === 'error') finish(message.error);
      });
      port.onDisconnect.addListener(() => finish({ code: 'EXTENSION_DISCONNECTED' }));
      port.postMessage({ method, payload });
    } catch { finish({ code: 'EXTENSION_DISCONNECTED' }); }
  });
}
