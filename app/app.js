const $ = id => document.getElementById(id);
let sessionToken = '';
let config = null;
let dirty = false;
let extensionDirectory = 'dist\\chrome-extension';

const errorMessages = {
  INVALID_CONFIG: '请检查密钥、完整接口地址和模型名称。',
  TRANSLATION_KEY_REQUIRED: '请填写翻译 API 密钥。',
  ASR_KEY_REQUIRED: '开启 TR 识别时，请填写语音识别 API 密钥。',
  CONFIG_CHANGED: '配置文件已在其他地方修改，请刷新本页后重新保存。',
  CONFIG_BUSY: '请先在扩展中关闭声音采集，再保存配置。',
  CONFIG_SAVE_FAILED: '保存失败，请确认系统文件夹可以写入。',
  UNAUTHORIZED: '本机服务可能已重启，请刷新本页后重试。'
};

async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  if (sessionToken) headers.set('Authorization', `Bearer ${sessionToken}`);
  const response = await fetch(path, {
    ...options,
    headers,
    cache: 'no-store',
    signal: AbortSignal.timeout(8000)
  });
  const body = await response.json();
  if (!response.ok) {
    const code = typeof body.error === 'string' ? body.error : body.error?.code;
    throw new Error(errorMessages[code] || '本机服务未能完成操作，请稍后重试。');
  }
  return body;
}

function feedback(id, text, isError = false) {
  $(id).textContent = text;
  $(id).dataset.error = String(isError);
}

function updateAsrFields() {
  const enabled = $('asr-enabled').checked;
  $('asr-fields').hidden = !enabled;
  $('asr-fields').disabled = !enabled;
  $('asr-off-note').hidden = enabled;
  $('asr-key').required = enabled && !config?.asr?.keySaved;
  $('asr-endpoint').required = enabled;
  $('asr-model').required = enabled;
}

function canPair() {
  return Boolean(config?.translation?.configured && (!config.asr.enabled || config.asr.configured) && !dirty);
}

function showConfig(nextConfig) {
  config = nextConfig;
  dirty = false;
  if (typeof config.projectRoot === 'string' && config.projectRoot) {
    extensionDirectory = `${config.projectRoot.replace(/[\\/]+$/, '')}\\dist\\chrome-extension`;
    $('extension-path').textContent = extensionDirectory;
  }
  const { translation, asr } = config;
  $('translation-key').value = '';
  $('translation-key').required = !translation.keySaved;
  $('translation-key').placeholder = translation.keySaved ? '密钥已保存，留空继续使用' : '填写你的 API Key';
  $('translation-endpoint').value = translation.endpoint || 'https://api.deepseek.com/chat/completions';
  $('translation-model').value = translation.model || 'deepseek-flash';
  $('translation-thinking').value = translation.thinking ?? 'disabled';
  $('asr-enabled').checked = Boolean(asr.enabled);
  $('asr-key').value = '';
  $('asr-key').placeholder = asr.keySaved ? '密钥已保存，留空继续使用' : '填写百炼 API Key';
  $('asr-endpoint').value = asr.endpoint || '';
  $('asr-model').value = asr.model || 'qwen-audio-3.1-asr-flash-streaming';
  updateAsrFields();
  const ready = canPair();
  $('config-status').textContent = ready ? '已配置' : '待完成';
  $('config-status').dataset.ready = String(ready);
  $('copy-pair').disabled = !ready;
  feedback('pair-status', ready ? '配置已就绪，可以复制配对码。' : '请先保存有效的服务配置。');
}

function markDirty() {
  dirty = true;
  $('config-status').textContent = '未保存';
  $('config-status').dataset.ready = 'false';
  $('copy-pair').disabled = true;
  feedback('save-status', '有未保存的修改。');
  feedback('pair-status', '请先保存修改，再复制配对码。');
}

async function copyText(text, statusId, fallbackId, inputId, successText) {
  try {
    await navigator.clipboard.writeText(text);
    $(fallbackId).hidden = true;
    $(inputId).value = '';
    feedback(statusId, successText);
  } catch {
    $(inputId).value = text;
    $(fallbackId).hidden = false;
    $(inputId).focus();
    $(inputId).select();
    feedback(statusId, '浏览器未允许自动复制，请手动复制下方内容。');
  }
}

async function connect() {
  try {
    sessionToken = (await api('/api/session')).token;
    showConfig(await api('/api/config'));
    $('service-status').textContent = '本机服务已连接';
    $('service-status').dataset.state = 'online';
    $('save').disabled = false;
    feedback('save-status', canPair() ? '配置已保存在本机。' : '填写后保存，即可继续配对。');
  } catch {
    $('service-status').textContent = '本机服务未连接';
    $('service-status').dataset.state = 'error';
    feedback('save-status', '请启动本机服务，然后刷新本页。', true);
    $('config-status').textContent = '未连接';
  }
}

$('config-form').addEventListener('input', markDirty);
$('config-form').addEventListener('change', markDirty);
$('asr-enabled').addEventListener('change', updateAsrFields);
$('config-form').addEventListener('invalid', event => {
  const section = event.target.closest('details');
  if (section) section.open = true;
}, true);

$('config-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('save').disabled = true;
  feedback('save-status', '正在保存…');
  const payload = {
    translation: {
      key: $('translation-key').value.trim(),
      endpoint: $('translation-endpoint').value.trim(),
      model: $('translation-model').value.trim(),
      thinking: $('translation-thinking').value
    },
    asr: {
      key: $('asr-key').value.trim(),
      enabled: $('asr-enabled').checked,
      endpoint: $('asr-endpoint').value.trim(),
      model: $('asr-model').value.trim()
    }
  };
  try {
    const saved = await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    showConfig(saved);
    feedback('save-status', '已保存，立即生效；已有配对继续有效。');
  } catch (error) {
    const message = error.name === 'TypeError' || error.name === 'TimeoutError'
      ? '未能连接本机服务，请确认服务仍在运行后重试。'
      : error.message || '保存失败，请稍后重试。';
    feedback('save-status', message, true);
  } finally {
    $('save').disabled = false;
  }
});

$('copy-pair').addEventListener('click', async () => {
  $('copy-pair').disabled = true;
  try {
    sessionToken = (await api('/api/session')).token;
    await copyText(sessionToken, 'pair-status', 'pair-fallback', 'pair-code', '已复制，分别粘贴到脚本和采集扩展的配对设置。');
  } catch {
    feedback('pair-status', '无法取得配对码，请确认本机服务已启动后重试。', true);
  } finally {
    $('copy-pair').disabled = !canPair();
  }
});

$('copy-extension').addEventListener('click', async () => {
  await copyText(extensionDirectory, 'extension-copy-status', 'extension-fallback', 'extension-copy-value', '已复制，在加载扩展时选择此目录。');
});

connect();
