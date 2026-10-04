import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { createTranslator, TranslationError } from './lib/translator.mjs';
import { createAsr, AsrError } from './lib/qwen-asr.mjs';
import { createLiveTranslator } from './lib/live-translate.mjs';
import { createRadioService } from './lib/radio-service.mjs';
import { createSettingsStore } from './lib/settings.mjs';

export const VERSION = '0.9.1';
const DEFAULT_ROOT = dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.vtt': 'text/vtt; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm' };

function reply(res, status, body) {
  if (res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// Cue callbacks are synchronous. Queue only bounded NDJSON while the response
// applies backpressure; a stalled consumer must not leave paid ASR running.
function asrStream(res, abort) {
  const maxLineBytes = 512 * 1024, maxQueuedBytes = 1024 * 1024;
  let queue = [], queuedBytes = 0, blocked = false, ending = false, closed = false, stallTimer;
  let resolveDone, rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  // A disconnect can happen before transcribe returns and starts awaiting done.
  done.catch(() => {});
  const cleanup = () => {
    clearTimeout(stallTimer);
    res.removeListener('drain', onDrain);
    res.removeListener('finish', onFinish);
    res.removeListener('close', onClose);
    res.removeListener('error', onError);
    queue = []; queuedBytes = 0;
  };
  const onFinish = () => { closed = true; cleanup(); resolveDone(); };
  const onClose = () => {
    if (closed) return;
    closed = true; cleanup(); abort.abort(); rejectDone(new AsrError('CANCELLED', 499));
  };
  const onError = () => { onClose(); res.destroy(); };
  const pump = () => {
    if (closed || res.destroyed) return;
    while (!blocked && queue.length) {
      const { line, bytes } = queue.shift(); queuedBytes -= bytes;
      if (!res.headersSent) res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no',
      });
      blocked = !res.write(line);
      if (blocked) {
        stallTimer = setTimeout(onError, 10000);
        stallTimer.unref?.();
      }
    }
    if (ending && queue.length === 0 && !res.writableEnded) res.end();
  };
  const onDrain = () => { clearTimeout(stallTimer); blocked = false; pump(); };
  const write = event => {
    if (closed || ending || res.destroyed) throw new AsrError('CANCELLED', 499);
    const line = JSON.stringify(event) + '\n', bytes = Buffer.byteLength(line);
    if (bytes > maxLineBytes || queuedBytes + res.writableLength + bytes > maxQueuedBytes) {
      throw new AsrError('ASR_OUTPUT_LIMIT', 502);
    }
    queue.push({ line, bytes }); queuedBytes += bytes; pump();
  };
  res.on('drain', onDrain); res.on('finish', onFinish); res.on('close', onClose); res.on('error', onError);
  return {
    write,
    async end(event, discardPending = false) {
      if (discardPending) { queue = []; queuedBytes = 0; }
      write(event); ending = true; pump(); await done;
    },
    dispose: cleanup,
  };
}

async function readJson(req, limit = 16384) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new TranslationError('REQUEST_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new TranslationError('INVALID_JSON', 400); }
}

function configuredServices(runtime) {
  const translator = runtime.translation ? createTranslator(runtime.translation) : {
    mode: 'api', translate: async () => { throw new TranslationError('NOT_CONFIGURED', 503); },
  };
  let asr = null, radio = null;
  if (runtime.asr) {
    if (['qwen3.8-livetranslate-flash-realtime', 'qwen3.5-livetranslate-flash-realtime'].includes(runtime.asr.model)) radio = createRadioService(createLiveTranslator(runtime.asr, { pace: 2 }));
    else asr = createAsr(runtime.asr);
  }
  return { translator, asr, radio };
}

export function createServer({ rootDir = DEFAULT_ROOT, translator = createTranslator(), asr = null, radio = null, maxConcurrent = 4, settingsStore = null } = {}) {
  const token = randomBytes(32).toString('hex');
  let active = 0;
  let activeAsr = 0;
  let activeRadio = 0;
  let saving = false, radioLeaseUntil = 0;
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const port = server.address()?.port;
    const expectedHost = `127.0.0.1:${port}`;
    const expectedOrigin = `http://${expectedHost}`;
    if (req.headers.host !== expectedHost) return reply(res, 403, { error: { code: 'INVALID_HOST' } });
    let path;
    try { path = decodeURIComponent(new URL(req.url, expectedOrigin).pathname); }
    catch { return reply(res, 400, { error: { code: 'INVALID_PATH' } }); }
    const origin = req.headers.origin;
    const fetchSite = req.headers['sec-fetch-site'];
    const localOrigin = origin === expectedOrigin;
    const wrongOrigin = origin !== undefined && !localOrigin;

    if (path === '/api/health' && req.method === 'GET') {
      return reply(res, 200, { service: 'f1tv-zh', version: VERSION, mode: translator.mode, asr: Boolean(asr || radio), radio: Boolean(radio) });
    }

    if (path === '/api/session' && req.method === 'GET') {
      if (wrongOrigin || (fetchSite && fetchSite !== 'same-origin') || (!localOrigin && fetchSite !== 'same-origin')) return reply(res, 403, { error: { code: 'SAME_ORIGIN_REQUIRED' } });
      return reply(res, 200, { token, mode: translator.mode, asr: Boolean(asr || radio), radio: Boolean(radio) });
    }
    if (path === '/api/config' && ['GET', 'POST'].includes(req.method)) {
      if (wrongOrigin || (fetchSite && fetchSite !== 'same-origin') || (!localOrigin && fetchSite !== 'same-origin')) return reply(res, 403, { error: { code: 'SAME_ORIGIN_REQUIRED' } });
      if (!settingsStore) return reply(res, 503, { error: { code: 'CONFIG_UNAVAILABLE' } });
      const publicConfig = () => ({ ...settingsStore.getConfig(), projectRoot: resolve(rootDir) });
      if (req.method === 'GET') return reply(res, 200, publicConfig());
      const auth = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${token}`);
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return reply(res, 401, { error: { code: 'UNAUTHORIZED' } });
      if ((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') return reply(res, 415, { error: { code: 'JSON_REQUIRED' } });
      if (saving || activeAsr || activeRadio || radioLeaseUntil > Date.now()) return reply(res, 409, { error: { code: 'CONFIG_BUSY' } });
      saving = true;
      try {
        const candidate = settingsStore.prepare(await readJson(req));
        const next = configuredServices(candidate.runtime);
        await settingsStore.commit(candidate);
        const previousRadio = radio;
        ({ translator, asr, radio } = next); radioLeaseUntil = 0;
        try { previousRadio?.dispose(); } catch { /* Saved settings already own the next request. */ }
        return reply(res, 200, publicConfig());
      } catch (cause) {
        return reply(res, cause instanceof TranslationError ? cause.status : 500,
          { error: { code: cause instanceof TranslationError ? cause.code : 'CONFIG_SAVE_FAILED' } });
      } finally { saving = false; }
    }
    if (['/api/translate', '/api/asr', '/api/radio'].includes(path) && req.method === 'POST') {
      const f1Origin = origin === 'https://f1tv.formula1.com';
      // Extension requests still require the same unpredictable bearer token.
      // /api/session remains restricted to the localhost page; no wildcard CORS.
      const extensionOrigin = /^chrome-extension:\/\/[a-p]{32}$/.test(origin || '');
      const auth = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${token}`);
      if ((wrongOrigin && !f1Origin && !extensionOrigin) || (fetchSite && !['none', 'same-origin'].includes(fetchSite) && !f1Origin && !extensionOrigin) || auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
        return reply(res, 401, { error: { code: 'UNAUTHORIZED' } });
      }
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return reply(res, 415, { error: { code: 'JSON_REQUIRED' } });
      const isAsr = path === '/api/asr';
      const isRadio = path === '/api/radio';
      if (saving && (isAsr || isRadio)) return reply(res, 409, { error: { code: 'CONFIG_BUSY' } });
      if (isAsr && !asr) return reply(res, 503, { error: { code: 'ASR_NOT_CONFIGURED' } });
      if (isRadio && !radio) return reply(res, 503, { error: { code: 'ASR_NOT_CONFIGURED' } });
      if (isAsr ? activeAsr >= 1 : isRadio ? activeRadio >= 4 : active >= maxConcurrent) return reply(res, 429, { error: { code: isAsr || isRadio ? 'ASR_BUSY' : 'BUSY' } });
      if (isAsr) activeAsr++; else if (isRadio) activeRadio++; else active++;
      const abort = new AbortController();
      const onClose = () => { if (!res.writableEnded) abort.abort(); };
      res.on('close', onClose);
      let stream;
      try {
        const input = await readJson(req, isAsr || isRadio ? 1_400_000 : 16384);
        if ((isAsr || (isRadio && input.action === 'poll')) && (req.headers.accept ?? '').split(',').some(type => type.trim().split(';')[0] === 'application/x-ndjson')) {
          stream = asrStream(res, abort);
        }
        const result = isRadio ? await radio.handle(input, {signal:abort.signal, onEvent: stream ? event => stream.write(event) : undefined}) : isAsr ? await asr.transcribe(input, {
          signal: abort.signal, ...(stream ? { onCue: cue => stream.write({ type: 'cue', cue }) } : {}),
          ...(stream && req.headers['x-f1zh-asr-diagnostics'] === '1' ? { onProgress: diagnostics => {
            try { stream.write({ type: 'progress', diagnostics }); }
            catch { abort.abort(); }
          } } : {}),
        }) : await translator.translate(input, { signal: abort.signal });
        if (isRadio) radioLeaseUntil = result.ended || input.action === 'cancel' ? 0 : Date.now() + 30000;
        if (stream) await stream.end({ type: 'done', ...result });
        else reply(res, 200, result);
      } catch (error) {
        abort.abort();
        if (isRadio && error.code === 'ASR_SESSION_EXPIRED') radioLeaseUntil = 0;
        const known = error instanceof TranslationError || error instanceof AsrError;
        const code = known ? error.code : 'INTERNAL_ERROR';
        const diagnostics = error instanceof AsrError ? error.diagnostics : undefined;
        if (res.headersSent && stream) {
          try { await stream.end({ type: 'error', code, diagnostics }, true); }
          catch { res.destroy(); }
        } else reply(res, known ? error.status || 502 : 500, { error: { code, diagnostics } });
      } finally {
        stream?.dispose();
        if (isAsr) activeAsr--; else if (isRadio) activeRadio--; else active--;
        res.removeListener('close', onClose);
      }
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) return reply(res, 405, { error: { code: 'METHOD_NOT_ALLOWED' } });
    if (path === '/') path = '/app/index.html';
    if (path === '/demo/') path = '/demo/index.html';
    if (!/^\/(app|demo|src|dist)\//.test(path) || path.includes('\\') || path.includes('\0') || path.split('/').some(part => part.startsWith('.')) || !TYPES[extname(path)]) {
      return reply(res, 404, { error: { code: 'NOT_FOUND' } });
    }
    try {
      const area = path.split('/')[1];
      const base = await realpath(resolve(rootDir, area));
      const target = await realpath(resolve(rootDir, `.${path}`));
      const info = await stat(target);
      if (!target.startsWith(base + sep) || !info.isFile()) return reply(res, 404, { error: { code: 'NOT_FOUND' } });
      if (['.mp4', '.webm'].includes(extname(path))) {
        let start = 0;
        let end = info.size - 1;
        const range = req.headers.range;
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!match || (!match[1] && !match[2])) {
            res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
            return res.end();
          }
          if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
          else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
          if (start > end || start >= info.size || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
            res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
            return res.end();
          }
        }
        const headers = { 'Content-Type': TYPES[extname(path)], 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 };
        if (range) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
        res.writeHead(range ? 206 : 200, headers);
        if (req.method === 'HEAD') return res.end();
        const stream = createReadStream(target, { start, end });
        stream.on('error', () => res.destroy());
        res.on('close', () => stream.destroy());
        return stream.pipe(res);
      }
      const data = await readFile(target);
      res.writeHead(200, { 'Content-Type': TYPES[extname(path)], 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch { reply(res, 404, { error: { code: 'NOT_FOUND' } }); }
  });
  server.requestTimeout = 35000;
  server.headersTimeout = 10000;
  server.on('close', () => radio?.dispose());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    let port = 3847, open = false;
    for (const argument of process.argv.slice(2)) {
      if (argument === '--open') open = true;
      else if (/^--port=\d+$/.test(argument)) port = Number(argument.slice(7));
      else throw Error('INVALID_ARGUMENT');
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('INVALID_PORT');
    const settingsStore = await createSettingsStore({ envFile: resolve(DEFAULT_ROOT, '.env'), defaults: process.env });
    const services = configuredServices(settingsStore.getRuntimeConfig());
    const server = createServer({ ...services, settingsStore, maxConcurrent: 5 });
    server.on('error', () => { console.error(`本机服务启动失败，请确认 ${port} 端口未被占用。`); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${port}/`;
      console.log(`F1 TV 翻译系统：${url}`);
      if (open && process.platform === 'win32') execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true }, () => {});
    });
  } catch {
    console.error('配置无效。请检查 .env 的模式、完整接口地址、模型、密钥及超时设置。');
    process.exitCode = 1;
  }
}
