// Read finalized sentences as they arrive. Never expose partial ASR hypotheses.
// The injected transport is GM_xmlhttpRequest; API credentials stay on localhost.
export function createAsrRequester(request, { service, getToken, timeoutMs = 30000, path = '/api/asr' }) {
  return (payload, signal, onCue = () => {}) => new Promise((resolve, reject) => {
    let handle, reader, finished = false, reading = false, seenChars = 0;
    let pending = '', receivedChars = 0, result = null, httpStatus = 200;
    let diagnostics;
    const errorFor = code => Object.assign(Error(code), { code, diagnostics });
    const keepDiagnostics = value => {
      if (!value || !['connecting', 'starting', 'sending', 'recognizing'].includes(value.stage)) return;
      diagnostics = { stage: value.stage };
      for (const key of ['elapsedMs','audioMs','sentAudioMs','resultEvents','finalSentences','lastResultMs',
        'connectedMs','taskStartedMs','finishSentMs','firstResultMs']) {
        if (Number.isFinite(value[key]) && value[key] >= 0) diagnostics[key] = value[key];
      }
    };
    const safeCode = code => typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'ASR_INVALID_RESPONSE';
    const done = (code, value) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (code) {
        try { handle?.abort(); } catch { /* Some older GM fetch transports cannot abort. */ }
        void reader?.cancel().catch(() => {});
        reject(errorFor(safeCode(code)));
      } else resolve(value);
    };
    const abort = () => done('CANCELLED');
    // Own timeout also covers GM implementations whose fetch mode ignores timeout.
    const timer = setTimeout(() => done('ASR_CLIENT_TIMEOUT'), timeoutMs);
    if (signal.aborted) return done('CANCELLED');
    signal.addEventListener('abort', abort, { once: true });
    const event = line => {
      if (!line.trim()) return;
      const item = JSON.parse(line);
      keepDiagnostics(item?.diagnostics || item?.error?.diagnostics);
      if (httpStatus !== 200) throw errorFor(httpStatus === 401 ? 'UNAUTHORIZED' : safeCode(item?.error?.code));
      if (item?.type === 'error' || item?.error) throw errorFor(safeCode(item.code || item.error.code));
      if (result) throw errorFor('ASR_INVALID_RESPONSE');
      if (item?.type === 'progress') {
        if (!diagnostics) throw errorFor('ASR_INVALID_RESPONSE');
      } else if (item?.type === 'cue') {
        const cue = item.cue;
        if (typeof cue?.text !== 'string' || !cue.text.trim() || cue.text.length > 3000 ||
            !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start) {
          throw errorFor('ASR_INVALID_RESPONSE');
        }
        onCue(cue);
      } else if ((item?.type === 'done' || !item?.type) && Array.isArray(item?.cues) && item.cues.length <= 1000) {
        result = { cues: item.cues, usage: item.usage };
        for (const key of ['sessionId', 'cursor', 'ended', 'diagnostics']) if (item[key] !== undefined) result[key] = item[key];
        // The application-level done event is authoritative, including silence.
        // Do not depend on the GM bridge also signaling EOF to finish the task.
        done(null, result);
        void reader?.cancel().catch(() => {});
      } else throw errorFor('ASR_INVALID_RESPONSE');
    };
    const consume = text => {
      if (finished || !text) return;
      receivedChars += text.length;
      if (receivedChars > 2_000_000) throw errorFor('ASR_INVALID_RESPONSE');
      pending += text;
      let newline;
      while (!finished && (newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        event(line);
      }
    };
    const complete = () => {
      if (finished) return;
      if (pending.trim()) event(pending);
      pending = '';
      if (!result) throw errorFor('ASR_INVALID_RESPONSE');
      done(null, result);
    };
    const fail = error => done(error?.name === 'AbortError' ? 'CANCELLED' : error?.code || 'ASR_INVALID_RESPONSE');
    const readStream = async response => {
      reading = true; httpStatus = response.status || 200;
      try {
        reader = response.response.getReader();
        const decoder = new TextDecoder();
        while (!finished) {
          const chunk = await reader.read();
          if (finished) break;
          if (chunk.done) { consume(decoder.decode()); complete(); break; }
          consume(typeof chunk.value === 'string' ? chunk.value : decoder.decode(chunk.value, { stream: true }));
        }
      } catch (error) { fail(error); }
      finally { try { reader?.releaseLock(); } catch { /* A canceled read may still be pending. */ } }
    };
    const progress = response => {
      if (finished || reading || typeof response.responseText !== 'string') return;
      httpStatus = response.status || httpStatus;
      const text = response.responseText;
      if (text.length < seenChars) throw errorFor('ASR_INVALID_RESPONSE');
      const tail = text.slice(seenChars); seenChars = text.length; consume(tail);
    };
    try {
      handle = request({ method: 'POST', url: `${service}${path}`, anonymous: true,
        responseType: 'stream', timeout: timeoutMs,
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson', Authorization: `Bearer ${getToken()}`,
          'X-F1ZH-ASR-Diagnostics': '1' },
        data: JSON.stringify(payload),
        onloadstart: response => { if (!finished && response.response?.getReader) void readStream(response); },
        onprogress: response => { try { progress(response); } catch (error) { fail(error); } },
        onload: response => {
          if (finished || reading) return;
          if (response.response?.getReader) { void readStream(response); return; }
          try { progress(response); complete(); } catch (error) { fail(error); }
        },
        onerror: () => done('LOCAL_SERVICE_UNAVAILABLE'), ontimeout: () => done('ASR_CLIENT_TIMEOUT'), onabort: abort
      });
      if (finished) { try { handle?.abort(); } catch { /* Synchronous transport failure. */ } }
    } catch { done('LOCAL_SERVICE_UNAVAILABLE'); }
  });
}
