import { randomUUID } from 'node:crypto';
import { AsrError } from './qwen-asr.mjs';

// One paired browser owns one continuous upstream session. Poll reconnects do
// not restart recognition; canceled/abandoned sessions have a bounded lifetime.
export function createRadioService(translator, { idleMs = 30000, pollMs = 15000 } = {}) {
  let current = null;
  const safeError = error => error instanceof AsrError ? error : new AsrError('ASR_UPSTREAM_FAILED');
  const touch = entry => {
    clearTimeout(entry.lease);
    entry.lease = setTimeout(() => { entry.session?.cancel(); entry.controller.abort(); }, idleMs);
    entry.lease.unref?.();
  };
  const notify = entry => { for (const listener of [...entry.listeners]) listener(); };
  const enqueue = (entry, event) => {
    if (entry.ended) return;
    const size = Buffer.byteLength(JSON.stringify(event));
    if (entry.bytes + size > 1_000_000 || entry.events.length >= 1000) {
      entry.error = new AsrError('ASR_OUTPUT_LIMIT'); entry.ended = true;
      entry.session?.cancel(); entry.controller.abort(); notify(entry); return;
    }
    entry.events.push({ seq: ++entry.seq, event, size }); entry.bytes += size;
    notify(entry);
  };
  const stop = entry => { clearTimeout(entry.lease); entry.controller.abort(); entry.session?.cancel(); };
  return {
    async handle(input, { signal, onEvent } = {}) {
      if (input?.action === 'open') {
        if (current && !current.ended) throw new AsrError('ASR_BUSY', 429);
        if (!Number.isFinite(input.start) || input.start < 0 || input.start > 1e9) throw new AsrError('ASR_INVALID_AUDIO', 400);
        if (current) stop(current);
        const entry = { id: randomUUID(), controller: new AbortController(), events: [], bytes: 0,
          listeners: new Set(), seq: 0, ended: false, polling: false, pushing: false };
        current = entry;
        const abortOpen = () => entry.controller.abort();
        signal?.addEventListener('abort', abortOpen, { once: true });
        if (signal?.aborted) abortOpen();
        try {
          entry.session = await translator.open({ start: input.start, signal: entry.controller.signal,
            onCue: cue => enqueue(entry, { type: 'cue', cue }),
            onProgress: diagnostics => enqueue(entry, { type: 'progress', diagnostics }) });
          entry.session.done.then(result => { entry.result = result; entry.ended = true; clearTimeout(entry.lease); notify(entry); }, error => {
            entry.error = safeError(error); entry.ended = true; clearTimeout(entry.lease); notify(entry);
          });
          touch(entry);
          return { cues: [], sessionId: entry.id, cursor: 0 };
        } catch (error) { stop(entry); if (current === entry) current = null; throw safeError(error); }
        finally { signal?.removeEventListener('abort', abortOpen); }
      }
      const entry = current;
      if (!entry || input?.sessionId !== entry.id) {
        if (input?.action === 'cancel') return { cues: [], ended: true };
        throw new AsrError('ASR_SESSION_EXPIRED', 409);
      }
      if (input.action === 'cancel') { stop(entry); entry.ended = true; notify(entry); return { cues: [], ended: true }; }
      if (input.action === 'poll') {
        const after = input.cursor;
        if (!Number.isSafeInteger(after) || after < 0 || after > entry.seq) throw new AsrError('ASR_INVALID_AUDIO', 400);
        if (entry.polling || typeof onEvent !== 'function') throw new AsrError('ASR_BUSY', 429);
        entry.polling = true;
        while (entry.events.length && entry.events[0].seq <= after) entry.bytes -= entry.events.shift().size;
        let cursor = after;
        if (!entry.ended) touch(entry);
        return await new Promise((resolve, reject) => {
          let done = false, timer;
          const cleanup = () => { clearTimeout(timer); entry.listeners.delete(flush); signal?.removeEventListener('abort', abort); entry.polling = false; };
          const finish = error => {
            if (done) return; done = true; cleanup();
            if (error) reject(error);
            else resolve({ cues: [], cursor, ended: entry.ended, ...(entry.ended ? { usage: entry.result?.usage, diagnostics: entry.result?.diagnostics } : {}) });
          };
          const flush = () => {
            if (done) return;
            try {
              for (const item of entry.events) if (item.seq > cursor) { onEvent(item.event); cursor = item.seq; }
              if (entry.ended) finish(entry.error);
            } catch (error) { finish(safeError(error)); }
          };
          const abort = () => finish(new AsrError('CANCELLED', 499));
          entry.listeners.add(flush); signal?.addEventListener('abort', abort, { once: true });
          timer = setTimeout(() => { flush(); finish(); }, pollMs);
          if (signal?.aborted) abort(); else flush();
        });
      }
      if (entry.error) throw entry.error;
      if (input.action === 'finish') {
        const result = entry.ended ? entry.result : await entry.session.finish();
        return { cues: [], ended: true, usage: result?.usage, diagnostics: result?.diagnostics };
      }
      if (input.action !== 'append' || entry.ended) throw new AsrError('ASR_SESSION_EXPIRED', 409);
      if (entry.pushing) throw new AsrError('ASR_BUSY', 429);
      entry.pushing = true; touch(entry);
      const abortAppend = () => stop(entry);
      signal?.addEventListener('abort', abortAppend, { once: true });
      try {
        if (signal?.aborted) throw new AsrError('CANCELLED', 499);
        await entry.session.append(input); touch(entry);
        return { cues: [] };
      } finally { entry.pushing = false; signal?.removeEventListener('abort', abortAppend); }
    },
    dispose() { if (current) stop(current); current = null; },
  };
}
