// Chromium does not proxy service-worker WebSocket handshakes through DNR.
// Keep ASR and authorization in the worker, but own the native socket in a
// same-extension document. This port carries no credentials.
const PORT_NAME = 'f1zh-websocket';
const MAX_BUFFERED_BYTES = 65536;
const encoder = new TextEncoder();

function encodeBytes(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

export class DocumentWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url, { chromeApi = globalThis.chrome } = {}) {
    super();
    this.url = url;
    this.binaryType = 'arraybuffer';
    this._state = 0;
    this._pending = new Map();
    this._pendingBytes = 0;
    this._remoteBytes = 0;
    this._sequence = 0;
    this._acknowledged = 0;
    this._onMessage = message => this._receive(message);
    this._onDisconnect = () => this._finish(true);
    try {
      this._port = chromeApi.runtime.connect({ name: PORT_NAME });
      this._port.onMessage.addListener(this._onMessage);
      this._port.onDisconnect.addListener(this._onDisconnect);
      this._port.postMessage({ type: 'connect', url });
    } catch {
      // Like native WebSocket, report transport failure after listeners can
      // be attached by the caller.
      queueMicrotask(() => this._finish(true));
    }
  }

  get readyState() { return this._state; }
  get bufferedAmount() { return this._pendingBytes + this._remoteBytes; }

  send(data) {
    if (this._state !== 1) throw new Error('WEBSOCKET_NOT_OPEN');
    let payload, size;
    if (typeof data === 'string') {
      size = encoder.encode(data).byteLength;
      payload = { text: data };
    } else {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data)
        : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
      if (!bytes) throw new Error('WEBSOCKET_INVALID_DATA');
      size = bytes.byteLength;
      if (size > MAX_BUFFERED_BYTES) throw new Error('WEBSOCKET_BACKPRESSURE');
      payload = { base64: encodeBytes(bytes) };
    }
    if (size > MAX_BUFFERED_BYTES || this.bufferedAmount + size > MAX_BUFFERED_BYTES) throw new Error('WEBSOCKET_BACKPRESSURE');
    const sequence = ++this._sequence;
    this._pending.set(sequence, size);
    this._pendingBytes += size;
    try { this._port.postMessage({ type: 'send', sequence, ...payload }); }
    catch { this._finish(true); throw new Error('WEBSOCKET_DISCONNECTED'); }
  }

  close(code = 1000) {
    if (this._state >= 2) return;
    this._state = 2;
    try { this._port?.postMessage({ type: 'close', code: code === 1000 ? code : 1000 }); } catch {}
    // Disconnect is also the host's cancellation signal, including when the
    // handshake has not opened. No response from a dying document is needed.
    this._finish(false);
  }

  _receive(message) {
    if (this._state === 3 || !message) return;
    if (message.type === 'open') {
      if (this._state !== 0) return this._finish(true);
      this._state = 1;
      this.dispatchEvent(new Event('open'));
    } else if (message.type === 'buffer') {
      const { sequence, bufferedAmount } = message;
      if (!Number.isInteger(sequence) || sequence < this._acknowledged || sequence > this._sequence ||
          !Number.isInteger(bufferedAmount) || bufferedAmount < 0 || bufferedAmount > MAX_BUFFERED_BYTES) return this._finish(true);
      this._acknowledged = sequence;
      for (const [id, size] of this._pending) {
        if (id > sequence) break;
        this._pendingBytes -= size; this._pending.delete(id);
      }
      this._remoteBytes = bufferedAmount;
    } else if (message.type === 'message') {
      if (this._state === 1) this.dispatchEvent(new MessageEvent('message', { data: message.data }));
    } else if (message.type === 'error') this._finish(true);
    else if (message.type === 'close') this._finish(false);
    else this._finish(true);
  }

  _finish(error) {
    if (this._state === 3) return;
    this._state = 3;
    this._pending.clear(); this._pendingBytes = 0; this._remoteBytes = 0;
    this._port?.onMessage.removeListener(this._onMessage);
    this._port?.onDisconnect.removeListener(this._onDisconnect);
    try { this._port?.disconnect(); } catch {}
    if (error) this.dispatchEvent(new Event('error'));
    this.dispatchEvent(new Event('close'));
  }
}
