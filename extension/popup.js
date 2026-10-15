const nodes = Object.fromEntries([...document.querySelectorAll('[id]')].map(node => [node.id, node]));
let tabId;
let currentState = null;
let polling = false;
let pending = false;
let pendingAction = '';
let disposed = false;
let pollTimer;
let actionError = '';
let connectionError = '';
nodes.version.textContent = `v${chrome.runtime.getManifest().version}`;

function text(id, value) {
  const next = String(value ?? '—');
  if (nodes[id].textContent !== next) nodes[id].textContent = next;
}

function timeLabel(value) {
  if (typeof value === 'string' && value.trim()) return value;
  if (!Number.isFinite(value) || value < 0) return '—';
  const seconds = Math.floor(value);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return `${hours ? `${hours}:` : ''}${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function safeTitle(value) {
  if (typeof value !== 'string' || !value.trim()) return '—';
  return /^(?:https?|chrome(?:-extension)?):\/\//i.test(value.trim()) ? 'F1 TV 标签页' : value;
}

function metric(value, unit, digits = 0) {
  return Number.isFinite(value) ? `${value.toFixed(digits)} ${unit}` : '—';
}

function stageLabel(status, active) {
  if (!active) return status.state === 'error' ? '采集已停止' : '尚未开始';
  if (status.state === 'paused') return '等待播放';
  const labels = { idle: '等待音频', waiting: '等待音频窗口', connecting: '连接识别服务', starting: '准备识别', sending: '正在发送音频', recognizing: '正在识别', complete: '本段识别完成', 'no-speech': '本段未识别到语音', error: '识别遇到问题' };
  return labels[status.asrStage] || (status.asrStage && /[\u4e00-\u9fff]/.test(status.asrStage) ? String(status.asrStage).slice(0, 50) : '等待状态更新');
}

function processingError(status) {
  const code = typeof status.lastError === 'string' ? status.lastError : status.lastError?.code;
  if (!code) return '';
  const messages = {
    ASR_AUTH_FAILED: '语音识别认证失败，请在设置中检查识别密钥。',
    ASR_TIMEOUT: '语音识别超时，当前音频尚未获得定稿结果。',
    ASR_CONNECTION_FAILED: '无法连接语音识别服务，请检查识别地址和网络。',
    ASR_UPSTREAM_FAILED: '语音服务连接失败或拒绝请求，请检查识别配置及网络。',
    ASR_CONNECTION_CLOSED: '语音连接中断，本段未完成；请检查网络。',
    ASR_CONNECT_TIMEOUT: '连接语音服务超时，请检查网络及识别地址。',
    ASR_START_TIMEOUT: '语音服务未能开始识别，请检查服务状态及模型名称。',
    ASR_SEND_TIMEOUT: '发送音频超时，请检查网络。',
    ASR_FINISH_TIMEOUT: '音频已发送，但识别结果超时，请检查服务状态。',
    ASR_BALANCE: '语音服务返回余额不足，请检查识别服务账户。',
    ASR_RATE_LIMITED: '语音服务正在限流，本段尚未识别完成。',
    ASR_NOT_CONFIGURED: '请先在设置中启用并配置语音识别。',
    ASR_AUTH_UNAVAILABLE: '无法设置语音连接认证，请重新加载扩展。',
    ASR_AUTH_CLEANUP_FAILED: '语音连接认证清理失败，请重新加载扩展后重试。',
    UPSTREAM_AUTH_FAILED: '服务认证失败，请在设置中检查密钥。',
    UPSTREAM_BALANCE: '服务返回余额不足，请检查服务账户。',
    UPSTREAM_RATE_LIMITED: '服务正在限流，部分音频或字幕尚未处理完成。',
    TRANSLATION_TIMEOUT: '翻译超时，当前原文尚未写入中文缓存。',
    HOST_PERMISSION_REQUIRED: '尚未获准连接服务，请在设置页重新保存并允许连接。'
  };
  return messages[code] || '识别或翻译遇到问题，部分音频或字幕尚未处理完成。请检查设置与服务状态。';
}

function render() {
  const state = currentState || {};
  const status = state.status || {};
  const active = state.active === true;
  const busy = pending || state.busy === true;
  const error = actionError || connectionError;
  const pipelineError = processingError(status);
  text('config-state', currentState ? !state.configured ? '翻译未配置 · 请打开设置' : !state.asrConfigured ? '语音识别未配置或未启用 · 请打开设置' : '翻译与识别配置已保存' : '读取配置…');
  let label = currentState ? '已关闭' : '读取状态…';
  let tone = '';
  if (busy) { label = pendingAction === 'stop' ? '正在关闭…' : pendingAction === 'start' ? '正在准备…' : '正在处理…'; tone = 'waiting'; }
  else if (error || status.state === 'error') { label = active ? '采集遇到问题' : '无法开始采集'; tone = 'error'; }
  else if (active) {
    if (pipelineError) { label = '采集中 · 处理遇到问题'; tone = 'error'; }
    else if (status.state === 'paused') { label = '等待播放'; tone = 'waiting'; }
    else if (status.state === 'capturing') { label = '正在采集'; tone = 'active'; }
    else { label = '等待音频'; tone = 'waiting'; }
  }
  text('state', label);
  text('switch-label', active && state.elsewhere ? '正在采集声音' : '采集此页声音');
  text('switch-value', active ? 'ON' : 'OFF');
  nodes['switch-value'].dataset.on = String(active);
  nodes.state.dataset.tone = tone;
  nodes.capture.setAttribute('aria-checked', String(active));
  nodes.capture.disabled = !currentState || busy || (!active && (!state.configured || !state.asrConfigured || !state.supported || !!state.problem || !!connectionError));

  let notice = error || pipelineError;
  if (!notice && currentState && !active) notice = !state.supported ? '请打开 F1 TV 节目，在网页控制台进入声音采集页。' : state.problem || (!state.configured ? '请先在设置中保存翻译服务的 API 密钥。' : !state.asrConfigured ? '请在设置中启用并配置语音识别服务。' : '');
  if (!notice && active) notice = state.elsewhere ? `正在采集另一标签页。关闭此开关即可停止。${status.message ? ` ${status.message}` : ''}` : status.message || '';
  if (!notice && status.state === 'error') notice = status.message;
  nodes.notice.hidden = !notice;
  nodes.notice.dataset.tone = error || pipelineError || status.state === 'error' ? 'error' : !active && notice ? 'waiting' : '';
  text('notice', notice || '');

  text('source-label', active && state.elsewhere ? '正在采集另一标签页' : active ? '正在采集的标签页' : '当前标签页');
  text('tab-title', safeTitle(active ? state.captureTitle || state.tabTitle : state.tabTitle));
  text('page-label', state.pageLabel || '—');
  text('audio-label', state.audioLabel || '—');
  text('programme-time', timeLabel(state.programmeTime));
  text('received', metric(status.receivedSeconds, '秒', 1));
  text('level', metric(status.audioDb, 'dBFS'));
  text('windows', metric(status.asrWindows, '段'));
  text('recognized', metric(status.recognizedCues, '句'));
  text('cues', metric(status.cueCount, '句'));
  text('asr-stage', stageLabel(status, active));
}

async function refresh() {
  if (polling || pending || disposed) return;
  polling = true;
  try {
    const state = await chrome.runtime.sendMessage({ to: 'background', type: 'panel-state', tabId });
    if (!state || typeof state !== 'object' || typeof state.active !== 'boolean') throw Error('invalid-state');
    currentState = state;
    connectionError = '';
  } catch {
    connectionError = '暂时无法连接扩展，请重新打开面板。';
  } finally {
    polling = false;
    if (!disposed) render();
  }
}

nodes.capture.addEventListener('click', async () => {
  if (nodes.capture.disabled || pending || !currentState) return;
  pending = true;
  pendingAction = currentState.active ? 'stop' : 'start';
  actionError = '';
  render();
  try {
    const result = await chrome.runtime.sendMessage({ to: 'background', type: pendingAction, tabId });
    if (!result?.ok) actionError = result?.message || '操作未完成，请稍后重试。';
  } catch {
    actionError = '操作未完成，请重新打开面板后重试。';
  } finally {
    pending = false;
    pendingAction = '';
    await refresh();
  }
});

nodes.settings.addEventListener('click', () => {
  void chrome.runtime.openOptionsPage().catch(() => {
    actionError = '无法打开设置，请从扩展管理页打开扩展设置。';
    render();
  });
});

window.addEventListener('pagehide', () => {
  disposed = true;
  clearInterval(pollTimer);
});

async function initialize() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
    await refresh();
  } catch {
    connectionError = '暂时无法读取当前标签页，请重新打开面板。';
    render();
  }
  if (!disposed) pollTimer = setInterval(() => { void refresh(); }, 1000);
}

void initialize();
