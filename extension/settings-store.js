const STORAGE_KEY = 'providerSettings';
const DEFAULTS = Object.freeze({
  translation: Object.freeze({ mode: 'api', endpoint: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-flash', thinking: 'disabled', key: '', timeoutMs: 8000 }),
  asr: Object.freeze({ enabled: false, endpoint: '', model: 'qwen-audio-3.1-asr-flash-streaming',
    apiKey: '', timeoutMs: 25000 }),
});

export class SettingsError extends Error {
  constructor(code = 'INVALID_CONFIG', status = 400) {
    super(code); this.name = 'SettingsError'; this.code = code; this.status = status;
  }
}

function field(input, name) {
  const value = input?.[name];
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value)) throw new SettingsError();
  return value.trim();
}

export function checkedEndpoint(endpoint, protocol) {
  if (typeof endpoint !== 'string' || /[\x00-\x20\x7f*|^?#]/.test(endpoint)) throw new SettingsError();
  let url;
  try { url = new URL(endpoint); } catch { throw new SettingsError(); }
  // DNR urlFilter uses these characters as operators. Never allow an endpoint
  // to turn the exact WebSocket authorization rule into a wildcard rule.
  if (url.protocol !== protocol || url.username || url.password || url.search || url.hash ||
      /[*|^]/.test(url.href) || url.href.length > 2048) throw new SettingsError();
  return url.href;
}

export function permissionOrigin(endpoint) {
  const url = new URL(endpoint);
  checkedEndpoint(endpoint, url.protocol === 'wss:' ? 'wss:' : 'https:');
  return `${url.origin}/*`;
}

function checkKey(key) {
  if (typeof key !== 'string' || (key && !/^[A-Za-z0-9._~+/=:-]{1,1024}$/.test(key))) throw new SettingsError();
}

function checkedState(value) {
  const state = { translation: { ...DEFAULTS.translation, ...value?.translation }, asr: { ...DEFAULTS.asr, ...value?.asr } };
  const t = state.translation, a = state.asr;
  t.endpoint = checkedEndpoint(field(t, 'endpoint'), 'https:');
  t.model = field(t, 'model'); t.thinking = field(t, 'thinking');
  a.endpoint = field(a, 'endpoint'); a.model = field(a, 'model');
  if (a.endpoint) a.endpoint = checkedEndpoint(a.endpoint, 'wss:');
  checkKey(t.key); checkKey(a.apiKey);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(t.model) || !['', 'disabled', 'enabled'].includes(t.thinking) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(a.model) || typeof a.enabled !== 'boolean' ||
      !Number.isFinite(t.timeoutMs) || t.timeoutMs < 50 || t.timeoutMs > 60000 ||
      !Number.isFinite(a.timeoutMs) || a.timeoutMs < 50 || a.timeoutMs > 120000) throw new SettingsError();
  // Explicitly project stored data, so legacy or injected fields (including
  // custom prompts) never become provider request options.
  return {
    translation: { mode: 'api', endpoint: t.endpoint, model: t.model, thinking: t.thinking, key: t.key, timeoutMs: t.timeoutMs },
    asr: { enabled: a.enabled, endpoint: a.endpoint, model: a.model, apiKey: a.apiKey, timeoutMs: a.timeoutMs },
  };
}

export async function requireHostPermission(endpoint, chromeApi = globalThis.chrome) {
  let allowed = false;
  try { allowed = await chromeApi.permissions.contains({ origins: [permissionOrigin(endpoint)] }); } catch {}
  if (!allowed) throw new SettingsError('HOST_PERMISSION_REQUIRED', 403);
}

function publicView(state) {
  const t = state.translation, a = state.asr;
  return { translation: { configured: Boolean(t.key), keySaved: Boolean(t.key), endpoint: t.endpoint, model: t.model, thinking: t.thinking },
    asr: { configured: Boolean(a.enabled && a.endpoint && a.apiKey), keySaved: Boolean(a.apiKey), enabled: a.enabled, endpoint: a.endpoint, model: a.model },
    restartRequired: false };
}

export function createSettingsStore({ chromeApi = globalThis.chrome } = {}) {
  let accessReady;
  let writes = Promise.resolve();
  async function trustedStorage() {
    if (!accessReady) accessReady = (async () => {
      try { await chromeApi.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }); }
      catch { throw new SettingsError('CONFIG_STORAGE_FAILED', 500); }
    })().catch(error => { accessReady = undefined; throw error; });
    await accessReady;
    return chromeApi.storage.local;
  }
  async function loadSettings() {
    const storage = await trustedStorage();
    let stored;
    try { stored = (await storage.get(STORAGE_KEY))[STORAGE_KEY]; }
    catch { throw new SettingsError('CONFIG_READ_FAILED', 500); }
    try { return checkedState(stored); }
    catch { throw new SettingsError('INVALID_CONFIG', 400); }
  }
  const serializeWrite = operation => {
    const result = writes.then(operation);
    writes = result.catch(() => {});
    return result;
  };
  return {
    loadSettings,
    async publicSettings() { return publicView(await loadSettings()); },
    saveSettings(input) {
      return serializeWrite(async () => {
        if (!input || Array.isArray(input) || !input.translation || Array.isArray(input.translation) ||
            !input.asr || Array.isArray(input.asr) || typeof input.asr.enabled !== 'boolean') throw new SettingsError();
        const previous = await loadSettings();
        const t = input.translation, a = input.asr;
        const state = checkedState({
          translation: { ...previous.translation, key: field(t, 'key') || previous.translation.key,
            endpoint: field(t, 'endpoint'), model: field(t, 'model'), thinking: field(t, 'thinking') },
          asr: { ...previous.asr, apiKey: field(a, 'key') || previous.asr.apiKey, enabled: a.enabled,
            endpoint: field(a, 'endpoint') || previous.asr.endpoint, model: field(a, 'model') || previous.asr.model },
        });
        if (!state.translation.key) throw new SettingsError('TRANSLATION_KEY_REQUIRED');
        if (state.asr.enabled && !state.asr.apiKey) throw new SettingsError('ASR_KEY_REQUIRED');
        if (state.asr.enabled && !state.asr.endpoint) throw new SettingsError();
        await requireHostPermission(state.translation.endpoint, chromeApi);
        if (state.asr.enabled) await requireHostPermission(state.asr.endpoint, chromeApi);
        try { await (await trustedStorage()).set({ [STORAGE_KEY]: state }); }
        catch { throw new SettingsError('CONFIG_SAVE_FAILED', 500); }
        return publicView(state);
      });
    },
    clearSettings() {
      return serializeWrite(async () => {
        try { await (await trustedStorage()).remove(STORAGE_KEY); }
        catch { throw new SettingsError('CONFIG_SAVE_FAILED', 500); }
        return publicView(checkedState());
      });
    },
  };
}

let defaultStore;
const store = () => defaultStore ??= createSettingsStore();
export const loadSettings = () => store().loadSettings();
export const publicSettings = () => store().publicSettings();
export const saveSettings = input => store().saveSettings(input);
export const clearSettings = () => store().clearSettings();
