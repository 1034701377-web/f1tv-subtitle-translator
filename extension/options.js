import { parseLegacyConfig } from './import-config.js';

const nodes = Object.fromEntries([...document.querySelectorAll('[id]')].map(node => [node.id, node]));
const defaults = { translation: { endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-flash', thinking: 'disabled' }, asr: { enabled: false, endpoint: '', model: 'qwen-audio-3.1-asr-flash-streaming' } };
let savedConfig = null;
let busy = false;
let dirty = false;
nodes.version.textContent = `v${chrome.runtime.getManifest().version}`;

function feedback(id, message, tone = '') {
  nodes[id].textContent = message;
  nodes[id].dataset.tone = tone;
}

function renderControls() {
  for (const node of nodes['settings-form'].querySelectorAll('input, select')) node.disabled = busy || !savedConfig;
  nodes.save.disabled = busy || !savedConfig;
  nodes['test-translation'].disabled = busy || dirty || !savedConfig?.translation?.configured;
  nodes['asr-fields'].hidden = !nodes['asr-enabled'].checked;
  nodes['save-hint'].textContent = !savedConfig ? '读取设置后即可编辑' : dirty ? '有未保存的更改' : '保存后仍需手动开启字幕或采集';
}

function fillConfig(config) {
  savedConfig = config;
  for (const group of ['translation', 'asr']) {
    const value = { ...defaults[group], ...config[group] };
    nodes[`${group}-endpoint`].value = value.endpoint || '';
    nodes[`${group}-model`].value = value.model || '';
    nodes[`${group}-key`].value = '';
    nodes[`${group}-key`].placeholder = value.keySaved ? '密钥已保存；留空保留，输入新密钥可替换' : '填写服务商的 API 密钥';
  }
  nodes['translation-thinking'].value = config.translation?.thinking ?? 'disabled';
  nodes['asr-enabled'].checked = config.asr?.enabled === true;
  nodes['translation-state'].textContent = config.translation?.configured ? '配置已保存' : '待配置';
  nodes['translation-state'].dataset.ready = String(config.translation?.configured === true);
  nodes['asr-state'].textContent = config.asr?.enabled ? config.asr?.configured ? '已启用 · 配置已保存' : '已启用 · 待完善' : '未启用';
  nodes['asr-state'].dataset.ready = String(config.asr?.enabled && config.asr?.configured);
  nodes['translation-key-help'].textContent = config.translation?.keySaved ? '已保存的密钥不会回显；留空保留原密钥。' : '密钥只需填写一次；之后留空即可保留。';
  nodes['asr-key-help'].textContent = config.asr?.keySaved ? '已保存的密钥不会回显；留空保留原密钥。' : '启用服务不会自动采集；音频在你开启 TR 或声音采集后发送。';
  dirty = false;
  renderControls();
}

function failField(id, message) {
  const input = nodes[id];
  const details = input.closest('details');
  if (details) details.open = true;
  feedback('status', message, 'error');
  input.focus();
  return null;
}

function collectConfig() {
  const config = {
    translation: { endpoint: nodes['translation-endpoint'].value.trim(), model: nodes['translation-model'].value.trim(), thinking: nodes['translation-thinking'].value, key: nodes['translation-key'].value.trim() },
    asr: { enabled: nodes['asr-enabled'].checked, endpoint: nodes['asr-endpoint'].value.trim(), model: nodes['asr-model'].value.trim(), key: nodes['asr-key'].value.trim() }
  };
  if (!config.translation.key && !savedConfig.translation?.keySaved) return failField('translation-key', '请填写翻译服务的 API 密钥。');
  if (!config.translation.model) return failField('translation-model', '请填写翻译模型名称。');
  for (const group of ['translation', ...(config.asr.enabled ? ['asr'] : [])]) {
    let url;
    try { url = new URL(config[group].endpoint); } catch { return failField(`${group}-endpoint`, group === 'translation' ? '请填写完整的 HTTPS 翻译接口地址。' : '请填写服务商提供的完整 WSS 识别连接地址。'); }
    if (url.protocol !== (group === 'translation' ? 'https:' : 'wss:') || url.username || url.password || url.hash) return failField(`${group}-endpoint`, group === 'translation' ? '翻译接口必须使用 HTTPS，且地址中不能包含账号密码或片段。' : '实时识别必须使用 WSS，且地址中不能包含账号密码或片段。');
  }
  if (config.asr.enabled && !config.asr.key && !savedConfig.asr?.keySaved) return failField('asr-key', '请填写语音识别服务的 API 密钥。');
  if (config.asr.enabled && !config.asr.model) return failField('asr-model', '请填写识别模型名称。');
  return config;
}

// DNR authorization for WebSocket handshakes requires the WSS origin itself.
function permissionOrigin(endpoint) {
  const url = new URL(endpoint);
  return `${url.origin}/*`;
}

nodes['settings-form'].addEventListener('input', () => {
  dirty = true;
  feedback('status', '');
  feedback('test-status', '配置已更改。先保存设置，再检测翻译连接。');
  renderControls();
});
nodes['asr-enabled'].addEventListener('change', () => {
  if (nodes['asr-enabled'].checked && !nodes['asr-endpoint'].value.trim()) nodes['asr-advanced'].open = true;
  renderControls();
});

nodes['legacy-config'].addEventListener('change', async () => {
  const file = nodes['legacy-config'].files?.[0];
  if (!file || busy || !savedConfig) return;
  try {
    if (file.size > 65536) throw { code: 'LEGACY_CONFIG_TOO_LARGE' };
    const config = parseLegacyConfig(await file.text());
    for (const group of ['translation', 'asr']) {
      for (const field of ['endpoint', 'model', 'key']) {
        if (config[group][field]) nodes[`${group}-${field}`].value = config[group][field];
      }
    }
    nodes['translation-thinking'].value = config.translation.thinking;
    nodes['asr-enabled'].checked = config.asr.enabled;
    dirty = true;
    feedback('status', '已在本地读取旧配置。点击“保存设置”并允许连接原服务，即可完成迁移。');
    feedback('test-status', '先保存导入的配置，再检测翻译连接。');
    renderControls();
  } catch (error) {
    const messages = { LEGACY_CONFIG_TOO_LARGE: '文件过大，请选择旧版的 .env 配置文件。', TRANSLATION_KEY_REQUIRED: '此文件没有翻译 API 密钥，请确认选择了旧版 .env。', LEGACY_CONFIG_MODE_UNSUPPORTED: '旧配置不是 API 模式，请直接填写 API 配置。' };
    feedback('status', messages[error.code] || '无法读取此配置格式。请手动填写 API 配置；原设置未改变。', 'error');
  } finally { nodes['legacy-config'].value = ''; }
});

nodes['settings-form'].addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !savedConfig) return;
  const config = collectConfig();
  if (!config) return;
  const endpoints = [config.translation.endpoint, ...(config.asr.enabled ? [config.asr.endpoint] : [])];
  const origins = [...new Set(endpoints.map(permissionOrigin))];
  busy = true;
  nodes.save.textContent = '正在保存…';
  feedback('status', '');
  renderControls();
  try {
    // Keep the permission request directly inside this user gesture, before any await.
    const granted = await chrome.permissions.request({ origins });
    if (!granted) {
      feedback('status', '未获准连接所配置的服务地址，设置尚未保存。请再次保存并允许连接。', 'error');
      return;
    }
    const result = await chrome.runtime.sendMessage({ to: 'background', type: 'save-config', config });
    if (!result?.ok || !result.config) {
      feedback('status', result?.message || '设置未保存，请检查接口和模型后重试。', 'error');
      return;
    }
    fillConfig(result.config);
    feedback('status', '设置已保存在此浏览器。尚未检测 API 连接，也未开始采集。', 'success');
    feedback('test-status', '配置已保存。点击“检测翻译连接”确认服务是否可用。');
  } catch {
    feedback('status', '设置未保存，请重新打开设置页后重试。', 'error');
  } finally {
    busy = false;
    nodes.save.textContent = '保存设置';
    renderControls();
  }
});

nodes['test-translation'].addEventListener('click', async () => {
  if (nodes['test-translation'].disabled || busy) return;
  busy = true;
  nodes['test-translation'].textContent = '正在检测…';
  feedback('test-status', '正在向已保存的翻译服务发送短文本…');
  renderControls();
  try {
    const result = await chrome.runtime.sendMessage({ to: 'background', type: 'test-translation' });
    if (!result?.ok) {
      feedback('test-status', result?.message || '翻译连接检测未通过，请检查密钥、模型与服务地址。', 'error');
      return;
    }
    const elapsed = Number.isFinite(result.elapsedMs) ? ` · ${(result.elapsedMs / 1000).toFixed(1)} 秒` : '';
    feedback('test-status', `翻译连接成功${elapsed}${result.text ? `\n返回译文：${String(result.text).slice(0, 200)}` : ''}`, 'success');
  } catch {
    feedback('test-status', '检测未完成，请重新打开设置页后重试。', 'error');
  } finally {
    busy = false;
    nodes['test-translation'].textContent = '检测翻译连接';
    renderControls();
  }
});

async function initialize() {
  try {
    const config = await chrome.runtime.sendMessage({ to: 'background', type: 'get-config' });
    if (!config?.translation || !config?.asr) throw new Error('invalid-config');
    fillConfig(config);
  } catch {
    feedback('status', '暂时无法读取扩展设置，请重新打开此页。', 'error');
    nodes['translation-state'].textContent = '读取失败';
  }
}
void initialize();
