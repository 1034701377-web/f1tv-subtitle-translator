const PORT_NAME = 'f1zh-websocket';
const MAX_BUFFERED_BYTES = 65536;
const MAX_RESPONSE_BYTES = 65536;
const encoder = new TextEncoder();

function endpoint(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f*|^?#]/.test(value)) throw Error();
  const url = new URL(value);
  if (url.protocol !== 'wss:' || url.username || url.password) throw Error();
  return url.href;
}

function outgoing(message) {
  if (typeof message.text === 'string' && message.base64 === undefined) {
    if (message.text.length > MAX_BUFFERED_BYTES) throw Error();
    return { data: message.text, size: encoder.encode(message.text).byteLength };
  }
  if (typeof message.base64 !== 'string' || message.text !== undefined || !message.base64 ||
      message.base64.length > Math.ceil(MAX_BUFFERED_BYTES / 3) * 4 || message.base64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(message.base64)) throw Error();
  const binary = atob(message.base64);
  if (btoa(binary) !== message.base64 || binary.length > MAX_BUFFERED_BYTES) throw Error();
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  return { data: new Blob([bytes]), size: bytes.byteLength };
}

export function installWebSocketHost({ chromeApi = globalThis.chrome, WebSocketImpl = globalThis.WebSocket,
  drainIntervalMs = 20 } = {}) {
  let active;
  const listener = port => {
    // Other runtime ports belong to API/capture routing and must stay intact.
    if (port.name !== PORT_NAME) return;
    const sender = port.sender;
    if (sender?.id !== chromeApi.runtime.id || sender.tab || sender.url !== chromeApi.runtime.getURL('background.js') || active) {
      port.disconnect(); return;
    }
    let socket, closed = false, sequence = 0, drainTimer, connected = false;
    const finish = () => {
      if (closed) return;
      closed = true; clearTimeout(drainTimer);
      if (active === finish) active = undefined;
      port.onMessage.removeListener(receive); port.onDisconnect.removeListener(finish);
      try { if (socket && socket.readyState < 2) socket.close(1000); } catch {}
      try { port.disconnect(); } catch {}
    };
    active = finish;
    const post = message => {
      if (closed) return;
      try { port.postMessage(message); } catch { finish(); }
    };
    const failed = () => { post({ type: 'error' }); finish(); };
    const reportBuffer = () => {
      clearTimeout(drainTimer);
      if (closed || socket?.readyState !== 1) return;
      post({ type: 'buffer', sequence, bufferedAmount: socket.bufferedAmount });
      if (!closed && socket.bufferedAmount > 0) drainTimer = setTimeout(reportBuffer, drainIntervalMs);
    };
    const receive = message => {
      if (closed) return;
      try {
        if (message?.type === 'connect' && !connected) {
          connected = true;
          socket = new WebSocketImpl(endpoint(message.url));
          socket.binaryType = 'arraybuffer';
          socket.addEventListener('open', () => { if (!closed) post({ type: 'open' }); });
          socket.addEventListener('error', () => { if (!closed) failed(); });
          socket.addEventListener('close', () => { if (!closed) { post({ type: 'close' }); finish(); } });
          socket.addEventListener('message', event => {
            if (closed) return;
            // Preserve ASR's INVALID_RESPONSE validation without forwarding
            // oversized/binary payloads across the extension message channel.
            const valid = typeof event.data === 'string' && event.data.length <= MAX_RESPONSE_BYTES
              && encoder.encode(event.data).byteLength <= MAX_RESPONSE_BYTES;
            post({ type: 'message', data: valid ? event.data : null });
          });
        } else if (message?.type === 'send' && connected && socket?.readyState === 1) {
          if (!Number.isInteger(message.sequence) || message.sequence !== sequence + 1) throw Error();
          const frame = outgoing(message);
          if (frame.size > MAX_BUFFERED_BYTES || socket.bufferedAmount + frame.size > MAX_BUFFERED_BYTES) throw Error();
          socket.send(frame.data);
          sequence = message.sequence;
          reportBuffer();
        } else if (message?.type === 'close') finish();
        else throw Error();
      } catch { failed(); }
    };
    port.onMessage.addListener(receive);
    port.onDisconnect.addListener(finish);
  };
  chromeApi.runtime.onConnect.addListener(listener);
  return () => { chromeApi.runtime.onConnect.removeListener(listener); active?.(); };
}
