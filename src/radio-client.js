import { createAsrRequester } from './asr-client.js';

export function createRadioClient(request, options) {
  const rpc = createAsrRequester(request, { ...options, path: '/api/radio' });
  let cancellation = Promise.resolve();
  return {
    async open({ start, signal, onCue }) {
      await cancellation;
      const controller = new AbortController();
      let sessionId, cursor = 0, stopped = false, resolveDone, rejectDone, failure;
      const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
      done.catch(() => {});
      const cancel = () => {
        if (stopped) return; stopped = true; controller.abort();
        signal?.removeEventListener('abort', cancel);
        rejectDone(Object.assign(Error('CANCELLED'), { code: 'CANCELLED' }));
        if (sessionId) cancellation = rpc({ action: 'cancel', sessionId }, new AbortController().signal).catch(() => {});
      };
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      try {
        const opened = await rpc({ action: 'open', start }, controller.signal);
        if (typeof opened.sessionId !== 'string') throw Error('ASR_INVALID_RESPONSE');
        sessionId = opened.sessionId;
        void (async () => {
          try {
            while (!stopped) {
              const result = await rpc({ action: 'poll', sessionId, cursor }, controller.signal, cue => { if (!stopped) onCue(cue); });
              if (!Number.isSafeInteger(result.cursor) || result.cursor < cursor) throw Error('ASR_INVALID_RESPONSE');
              cursor = result.cursor;
              if (result.ended) {
                stopped = true; signal?.removeEventListener('abort', cancel); resolveDone(result); return;
              }
            }
          } catch (error) { if (!stopped) { failure = error; rejectDone(error); cancel(); } }
        })();
        return { done, cancel,
          async append(payload) { try { return await rpc({ ...payload, action: 'append', sessionId }, controller.signal); } catch (error) { throw failure || error; } },
          async finish() { try { await rpc({ action: 'finish', sessionId }, controller.signal); return await done; } catch (error) { throw failure || error; } },
        };
      } catch (error) { cancel(); throw error; }
    }
  };
}
