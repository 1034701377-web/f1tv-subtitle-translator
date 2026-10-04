const status = document.getElementById('status');
const input = document.getElementById('token'), save = document.getElementById('save');
let saving = false;
document.getElementById('pair').addEventListener('submit', async event => {
  event.preventDefault();
  if (saving) return;
  const token = input.value.trim();
  status.dataset.tone = '';
  if (!/^[a-f0-9]{64}$/.test(token)) {
    status.dataset.tone = 'error'; status.textContent = '配对码格式不正确，请从本机配置页重新复制。'; return;
  }
  saving = true; save.disabled = true; input.readOnly = true;
  save.textContent = '正在保存…'; status.textContent = '';
  try {
    const result = await chrome.runtime.sendMessage({ to: 'background', type: 'stop' });
    if (!result?.ok) throw Error('pairing-unavailable');
    await chrome.storage.session.set({ token });
    input.value = '';
    status.textContent = '配对已保存。回到采集页，在扩展面板打开“采集声音”即可开始。';
  } catch {
    status.dataset.tone = 'error'; status.textContent = '配对未保存，请重新打开本页后重试。';
  } finally {
    saving = false; save.disabled = false; input.readOnly = false; save.textContent = '保存配对';
  }
});
