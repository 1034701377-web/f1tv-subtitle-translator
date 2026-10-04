import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { readConfig, TranslationError } from './translator.mjs';
import { readAsrConfig } from './qwen-asr.mjs';

const defaults = {
  TRANSLATION_MODE: 'api', API_ENDPOINT: 'https://api.deepseek.com/chat/completions',
  API_MODEL: 'deepseek-flash', API_THINKING: 'disabled', API_TIMEOUT_MS: '8000', API_KEY: '',
  ASR_ENDPOINT: '',
  ASR_MODEL: 'qwen-audio-3.1-asr-flash-streaming', DASHSCOPE_API_KEY: '', ASR_TIMEOUT_MS: '25000',
};
const managed = ['TRANSLATION_MODE', 'API_ENDPOINT', 'API_MODEL', 'API_THINKING', 'API_KEY',
  'ASR_ENABLED', 'ASR_ENDPOINT', 'ASR_MODEL', 'DASHSCOPE_API_KEY'];
const error = (code = 'INVALID_CONFIG', status = 400) => new TranslationError(code, status);
const enabled = env => env.ASR_ENABLED === undefined ? Boolean(env.ASR_ENDPOINT && env.ASR_MODEL && env.DASHSCOPE_API_KEY) : env.ASR_ENABLED === 'true';

function value(input, field) {
  if (typeof input?.[field] !== 'string' || input[field].length > 2048 || /[\x00-\x1f\x7f]/.test(input[field])) throw error();
  return input[field].trim();
}
function checkKey(key) {
  if (key && !/^[A-Za-z0-9._~+/=:-]{1,1024}$/.test(key)) throw error();
}
function checkEndpoint(endpoint, protocols) {
  let url;
  try { url = new URL(endpoint); } catch { throw error(); }
  const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && protocols.includes('https:');
  if ((!protocols.includes(url.protocol) && !localHttp) || url.username || url.password || url.search || url.hash) throw error();
  return url.href;
}
function publicEndpoint(endpoint, protocols) {
  try { return checkEndpoint(endpoint, protocols); } catch { return ''; }
}
function runtimeConfig(env) {
  let translation = null, asr = null;
  try { translation = readConfig(env); } catch { /* An unconfigured install must still expose its settings page. */ }
  if (enabled(env)) { try { asr = readAsrConfig(env); } catch {} }
  return { translation, asr };
}
function serialize(env) {
  return Object.entries(env).map(([key, text]) => {
    const value = String(text);
    // Double-quoted dotenv values expand \n; preserve literal Windows paths too.
    const quote = ["'", '`', '"'].find(candidate => !value.includes(candidate)
      && parseEnv(`${key}=${candidate}${value}${candidate}`)[key] === value);
    if (!quote || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw error('CONFIG_FORMAT', 400);
    return `${key}=${quote}${value}${quote}`;
  }).join('\n') + '\n';
}
async function readExisting(path) {
  try { return await readFile(path, 'utf8'); } catch (cause) { if (cause.code === 'ENOENT') return ''; throw error('CONFIG_READ_FAILED', 500); }
}

export async function createSettingsStore({ envFile, defaults: supplied = {} }, { writeFileImpl = writeFile, renameImpl = rename } = {}) {
  const path = resolve(envFile);
  let original = await readExisting(path), persisted;
  try { persisted = parseEnv(original); } catch { throw error('CONFIG_READ_FAILED', 500); }
  // Only recognized environment overrides participate; never serialize process.env.
  const overrides = Object.fromEntries([...Object.keys(defaults), 'ASR_ENABLED'].filter(key => supplied[key] !== undefined).map(key => [key, supplied[key]]));
  let state = { ...defaults, ...overrides, ...persisted }, revision = 0;
  if (!Object.hasOwn(persisted, 'ASR_ENABLED') && !Object.hasOwn(overrides, 'ASR_ENABLED')) state.ASR_ENABLED = String(Boolean((persisted.ASR_ENDPOINT || overrides.ASR_ENDPOINT) && (persisted.ASR_MODEL || overrides.ASR_MODEL)));
  return {
    getRuntimeConfig: () => runtimeConfig(state),
    getConfig() {
      const runtime = runtimeConfig(state);
      return { translation: { configured: runtime.translation?.mode === 'api', keySaved: Boolean(state.API_KEY),
        endpoint: publicEndpoint(state.API_ENDPOINT, ['https:']), model: state.API_MODEL, thinking: state.API_THINKING },
      asr: { configured: Boolean(runtime.asr), keySaved: Boolean(state.DASHSCOPE_API_KEY), enabled: enabled(state),
        endpoint: publicEndpoint(state.ASR_ENDPOINT, ['wss:']), model: state.ASR_MODEL }, restartRequired: false };
    },
    prepare(input) {
      if (!input || Array.isArray(input) || !input.translation || !input.asr || Array.isArray(input.translation) || Array.isArray(input.asr) || typeof input.asr.enabled !== 'boolean') throw error();
      const next = { ...state };
      next.API_KEY = value(input.translation, 'key') || state.API_KEY;
      next.API_ENDPOINT = checkEndpoint(value(input.translation, 'endpoint'), ['https:']);
      next.API_MODEL = value(input.translation, 'model');
      next.API_THINKING = value(input.translation, 'thinking');
      next.TRANSLATION_MODE = 'api';
      next.DASHSCOPE_API_KEY = value(input.asr, 'key') || state.DASHSCOPE_API_KEY;
      next.ASR_ENDPOINT = value(input.asr, 'endpoint') || state.ASR_ENDPOINT;
      next.ASR_MODEL = value(input.asr, 'model') || state.ASR_MODEL;
      next.ASR_ENABLED = String(input.asr.enabled);
      checkKey(next.API_KEY); checkKey(next.DASHSCOPE_API_KEY);
      if (!next.API_KEY) throw error('TRANSLATION_KEY_REQUIRED');
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(next.API_MODEL) || !['', 'disabled', 'enabled'].includes(next.API_THINKING)) throw error();
      try {
        readConfig(next);
        if (input.asr.enabled || next.ASR_ENDPOINT) {
          next.ASR_ENDPOINT = checkEndpoint(next.ASR_ENDPOINT, ['wss:']);
          readAsrConfig({ ...next, DASHSCOPE_API_KEY: next.DASHSCOPE_API_KEY || 'validation-placeholder' });
        } else if (next.ASR_MODEL && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(next.ASR_MODEL)) throw error();
      } catch { throw error(); }
      if (input.asr.enabled && !next.DASHSCOPE_API_KEY) throw error('ASR_KEY_REQUIRED');
      const saved = { ...persisted };
      for (const key of managed) saved[key] = next[key];
      return { revision, state: next, persisted: saved, text: serialize(saved), runtime: runtimeConfig(next) };
    },
    async commit(candidate) {
      if (candidate.revision !== revision || await readExisting(path) !== original) throw error('CONFIG_CHANGED', 409);
      const temp = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFileImpl(temp, candidate.text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await renameImpl(temp, path);
      } catch { throw error('CONFIG_SAVE_FAILED', 500); }
      finally { await rm(temp, { force: true }).catch(() => {}); }
      state = candidate.state; persisted = candidate.persisted; original = candidate.text; revision++;
    },
  };
}
