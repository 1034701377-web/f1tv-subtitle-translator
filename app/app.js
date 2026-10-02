const $ = id => document.getElementById(id);
let sessionToken = '', keySaved = false;
const errors = {
  INVALID_CONFIG:'请检查密钥、完整接口地址和模型名称。',
  CONFIG_BUSY:'配置正在保存，请稍后再试。',
  CONFIG_SAVE_FAILED:'保存失败，请检查这个文件夹是否可写。',
  UNAUTHORIZED:'服务已经重启，请刷新本页后重新保存。'
};
async function api(path, options = {}) {
  const response = await fetch(path, {...options, cache:'no-store', signal:AbortSignal.timeout(5000)});
  const body = await response.json();
  if (!response.ok) throw Error(errors[body?.error?.code] || '无法连接本机服务，请确认服务窗口仍然打开。');
  return body;
}
function showConfig(config) {
  keySaved = config.keySaved;
  $('endpoint').value = config.endpoint;
  $('model').value = config.model;
  $('thinking').value = config.thinking;
  $('api-key').required = !keySaved;
  $('api-key').placeholder = keySaved ? '密钥已保存，留空继续使用' : '粘贴你自己的 API Key';
  $('config-status').textContent = config.configured ? '已保存' : keySaved ? '请检查配置' : '待配置';
  $('config-status').dataset.ready = String(config.configured);
  $('copy-pair').disabled = !config.configured;
}
async function connect() {
  try {
    const [session, config] = await Promise.all([api('/api/session'), api('/api/config')]);
    sessionToken = session.token; showConfig(config);
    $('service-status').textContent = '本机服务已连接'; $('service-status').dataset.state = 'online';
    $('save').disabled = false;
  } catch (error) {
    $('service-status').textContent = '本机服务未连接'; $('service-status').dataset.state = 'error';
    $('save-status').textContent = error.message; $('save-status').dataset.error = 'true';
  }
}
$('config-form').addEventListener('submit', async event => {
  event.preventDefault(); $('save').disabled = true; $('save-status').textContent = '正在保存…'; $('save-status').dataset.error = 'false';
  const key = $('api-key').value;
  $('api-key').value = '';
  try {
    const config = await api('/api/config', {method:'POST', headers:{'Content-Type':'application/json', Authorization:`Bearer ${sessionToken}`},
      body:JSON.stringify({key, endpoint:$('endpoint').value, model:$('model').value, thinking:$('thinking').value})});
    showConfig(config); $('save-status').textContent = '已保存，立即生效。';
  } catch (error) {$('save-status').textContent = error.message; $('save-status').dataset.error = 'true';}
  finally {$('save').disabled = false;}
});
$('copy-pair').addEventListener('click', async () => {
  $('copy-pair').disabled = true;
  try {
    // Refresh the pairing code in case the local service has restarted.
    sessionToken = (await api('/api/session')).token;
    try {
      await navigator.clipboard.writeText(sessionToken);
      $('pair-code').value = ''; $('pair-fallback').hidden = true;
      $('pair-status').textContent = '已复制，到 F1 TV 控制台粘贴即可。';
    } catch {
      $('pair-code').value = sessionToken; $('pair-fallback').hidden = false; $('pair-code').select();
      $('pair-status').textContent = '浏览器未允许自动复制，请手动复制下方配对码。';
    }
    $('pair-status').dataset.error = 'false';
  } catch (error) {$('pair-status').textContent = error.message; $('pair-status').dataset.error = 'true';}
  finally {$('copy-pair').disabled = false;}
});
connect();
