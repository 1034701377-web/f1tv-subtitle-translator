import http from 'node:http';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { createTranslator, readConfig, TranslationError } from './lib/translator.mjs';

export const VERSION = '0.8.0';
const root = new URL('./', import.meta.url);
const defaults = {API_ENDPOINT:'https://api.deepseek.com/chat/completions', API_MODEL:'deepseek-flash', API_THINKING:'disabled', API_TIMEOUT_MS:'8000', API_KEY:''};
const staticFiles = new Map([
  ['/', ['app/index.html', 'text/html; charset=utf-8']],
  ['/app/style.css', ['app/style.css', 'text/css; charset=utf-8']],
  ['/app/app.js', ['app/app.js', 'text/javascript; charset=utf-8']],
  ['/dist/f1tv-zh.user.js', ['dist/f1tv-zh.user.js', 'text/javascript; charset=utf-8']]
]);

async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) throw new TranslationError('BODY_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  try {return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch {throw new TranslationError('INVALID_JSON', 400);}
}
function validToken(header, token) {
  const candidate = typeof header === 'string' ? header : '';
  const expected = `Bearer ${token}`;
  return Buffer.byteLength(candidate) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
}

export async function createApp({port = 3847, envFile = new URL('.env', root)} = {}) {
  let settings = {...defaults};
  try {settings = {...settings, ...parseEnv(await readFile(envFile, 'utf8'))};}
  catch (error) {if (error.code !== 'ENOENT') throw Error('CONFIG_READ_FAILED');}
  let translator = null, saving = false, active = 0;
  const token = randomBytes(32).toString('hex');
  const configure = () => {
    translator = null;
    if (!settings.API_KEY) return;
    try {translator = createTranslator(readConfig(settings));} catch {}
  };
  configure();
  const publicConfig = () => ({configured:Boolean(translator), keySaved:Boolean(settings.API_KEY),
    endpoint:settings.API_ENDPOINT, model:settings.API_MODEL, thinking:settings.API_THINKING});

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status, body) => {
      if (res.destroyed) return;
      res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(body));
    };
    const fail = (status, code) => json(status, {error:{code}});
    try {
      const localPort = server.address()?.port || port;
      const selfOrigin = `http://127.0.0.1:${localPort}`;
      if (req.headers.host !== `127.0.0.1:${localPort}`) return fail(403, 'HOST_REJECTED');
      const origin = req.headers.origin;
      const sameOrigin = (!origin || origin === selfOrigin) && !['cross-site','same-site'].includes(req.headers['sec-fetch-site']);
      const f1Origin = origin === 'https://f1tv.formula1.com';
      if (!sameOrigin && !f1Origin) return fail(403, 'ORIGIN_REJECTED');
      if (f1Origin) res.setHeader('Access-Control-Allow-Origin', origin);
      const path = new URL(req.url, selfOrigin).pathname;
      if (req.method === 'OPTIONS' && path === '/api/translate' && f1Origin) {
        res.writeHead(204, {'Access-Control-Allow-Methods':'POST', 'Access-Control-Allow-Headers':'Content-Type, Authorization'}); return res.end();
      }
      if (req.method === 'GET' && path === '/api/health') return json(200, {service:'f1tv-zh', version:VERSION, configured:Boolean(translator)});
      if (req.method === 'GET' && ['/api/session','/api/config'].includes(path)) {
        if (!sameOrigin) return fail(403, 'ORIGIN_REJECTED');
        return json(200, path === '/api/session' ? {token} : publicConfig());
      }
      if (req.method === 'POST' && ['/api/config','/api/translate'].includes(path)) {
        if (path === '/api/config' && !sameOrigin) return fail(403, 'ORIGIN_REJECTED');
        if (!validToken(req.headers.authorization, token)) return fail(401, 'UNAUTHORIZED');
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return fail(415, 'JSON_REQUIRED');
        const body = await readJson(req);
        if (path === '/api/config') {
          if (saving) return fail(409, 'CONFIG_BUSY');
          if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'INVALID_CONFIG');
          const candidate = {...settings};
          for (const field of ['key','endpoint','model','thinking']) if (typeof body[field] !== 'string') return fail(400, 'INVALID_CONFIG');
          candidate.API_KEY = body.key.trim() || settings.API_KEY;
          candidate.API_ENDPOINT = body.endpoint.trim(); candidate.API_MODEL = body.model.trim(); candidate.API_THINKING = body.thinking;
          if (!/^[A-Za-z0-9._~+/=-]{8,1024}$/.test(candidate.API_KEY || '') || !/^[\w./:-]{1,200}$/.test(candidate.API_MODEL)) return fail(400, 'INVALID_CONFIG');
          try {
            const endpoint = new URL(candidate.API_ENDPOINT);
            if (endpoint.search) throw Error();
            candidate.API_ENDPOINT = endpoint.href;
            readConfig(candidate);
          } catch {return fail(400, 'INVALID_CONFIG');}
          saving = true;
          try {
            // Only the local .env receives the key. Responses never include it.
            const content = 'TRANSLATION_MODE=api\n' + Object.entries(candidate)
              .filter(([key]) => Object.hasOwn(defaults, key)).map(([key,value]) => `${key}=${value}`).join('\n') + '\n';
            const temp = new URL(`.env.${randomBytes(6).toString('hex')}.tmp`, root);
            await writeFile(temp, content, {mode:0o600}); await rename(temp, envFile);
            settings = candidate; configure(); return json(200, publicConfig());
          } catch {return fail(500, 'CONFIG_SAVE_FAILED');}
          finally {saving = false;}
        }
        if (!translator) return fail(503, 'NOT_CONFIGURED');
        if (active >= 5) return fail(503, 'BUSY');
        active++;
        const controller = new AbortController();
        const cancel = () => {if (!res.writableEnded) controller.abort();};
        res.on('close', cancel);
        try {json(200, await translator.translate(body, {signal:controller.signal}));}
        finally {active--; res.removeListener('close', cancel);}
        return;
      }
      const asset = req.method === 'GET' && sameOrigin && staticFiles.get(path);
      if (!asset) return fail(404, 'NOT_FOUND');
      const content = await readFile(new URL(asset[0], root));
      res.writeHead(200, {'Content-Type':asset[1]}); res.end(content);
    } catch (error) {
      fail(error instanceof TranslationError ? error.status : 500, error instanceof TranslationError ? error.code : 'LOCAL_SERVICE_ERROR');
    }
  });
  server.headersTimeout = 10000; server.requestTimeout = 15000;
  return server;
}

function openPage(url) {
  const args = process.platform === 'win32' ? ['cmd.exe', ['/c','start','',''+url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  execFile(args[0], args[1], {windowsHide:true}, () => {});
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.F1TV_PORT || 3847);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('服务端口无效。'); process.exitCode = 1;
  } else {
    const url = `http://127.0.0.1:${port}/`;
    try {
      const server = await createApp({port});
      server.on('error', async error => {
        if (error.code === 'EADDRINUSE') {
          try {
            const health = await (await fetch(`${url}api/health`, {signal:AbortSignal.timeout(1000)})).json();
            if (health.service === 'f1tv-zh' && health.version === VERSION) {
              if (process.argv.includes('--open')) openPage(url);
              console.log('本机服务已在运行，请使用配置页。'); return;
            }
          } catch {}
          console.error(`端口 ${port} 已被占用，请关闭旧版翻译服务后重试。`);
        } else console.error('服务启动失败，请检查目录权限。');
        process.exitCode = 1;
      });
      server.listen(port, '127.0.0.1', () => {
        console.log(`F1 TV 字幕翻译 v${VERSION}\n本机配置页：${url}\n观看期间保持这个窗口打开；结束后关闭窗口即可。`);
        if (process.argv.includes('--open')) openPage(url);
      });
    } catch {console.error('无法读取本机配置，请检查 .env 文件与目录权限。'); process.exitCode = 1;}
  }
}
