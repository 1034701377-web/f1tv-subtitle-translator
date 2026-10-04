// Page messages contain only clocks, control state and finalized subtitles.
// No audio, stream ID or pairing token is exposed to the website/userscript.
(() => {
  const origin = 'https://f1tv.formula1.com';
  const pending = new Map();
  const post = message => window.postMessage({ f1zhExtension: 1, ...message }, origin);
  let invalidated = false, lastNotice = null;
  const unavailable = reason => {
    if (invalidated) reason = 'context-invalidated';
    if (reason === 'context-invalidated') invalidated = true;
    if (lastNotice === reason) return;
    lastNotice = reason;
    post({ type: 'bridge-unavailable', reason, message: reason === 'context-invalidated'
      ? '扩展已重新加载，请刷新本页以恢复连接。'
      : '暂时无法连接扩展，请稍后重试；若持续失败，请刷新本页。' });
  };
  const runtimeReady = () => {
    if (invalidated || !chrome.runtime?.id) { unavailable('context-invalidated'); return false; }
    return true;
  };
  const send = async message => {
    if (!runtimeReady()) return;
    try {
      await chrome.runtime.sendMessage(message);
      if (runtimeReady()) {
        const recovered = lastNotice === 'transport-error';
        lastNotice = null;
        if (recovered) post({ type: 'installed' });
      }
    } catch (error) {
      unavailable(!chrome.runtime?.id || /extension context invalidated/i.test(error?.message || '')
        ? 'context-invalidated' : 'transport-error');
    }
  };
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== origin || event.data?.f1zhPage !== 1) return;
    const message = event.data;
    if (message.type === 'snapshot' && pending.has(message.requestId)) {
      const resolve = pending.get(message.requestId); pending.delete(message.requestId);
      resolve(message.snapshot); return;
    }
    if (message.type === 'hello') { if (runtimeReady()) post({ type: 'installed' }); return; }
    if (message.type === 'relay') {
      const packet = message.packet;
      if (typeof packet?.programmeId !== 'string' || !/^[A-Za-z0-9_:-]{1,120}$/.test(packet.programmeId) || !['hello', 'viewer-status', 'viewer-release'].includes(packet.type)
          || JSON.stringify(packet).length > 2000) return;
      void send({ to: 'background', type: 'relay', packet });
    } else if (['stop', 'clock-changed'].includes(message.type)) {
      void send({ to: 'background', type: message.type });
    }
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!runtimeReady() || sender.id !== chrome.runtime.id) return;
    if (message.type === 'snapshot') {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => { pending.delete(requestId); respond(null); }, 3000);
      pending.set(requestId, value => { clearTimeout(timer); respond(value); });
      post({ type: 'snapshot-request', requestId }); return true;
    }
    if (message.type === 'relay') post(message);
    if (message.type === 'status') post(message);
  });
  if (runtimeReady()) post({ type: 'installed' });
})();
