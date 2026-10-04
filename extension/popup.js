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

function render() {
  const state = currentState || {};
  const status = state.status || {};
  const active = state.active === true;
  const busy = pending || state.busy === true;
  const error = actionError || connectionError;
  text('pair-state', currentState ? state.paired ? '配对已保存' : '未配对' : '检查配对…');
  let label = currentState ? '已关闭' : '读取状态…';
  let tone = '';
  if (busy) { label = pendingAction === 'stop' ? '正在关闭…' : pendingAction === 'start' ? '正在准备…' : '正在处理…'; tone = 'waiting'; }
  else if (error || status.state === 'error') { label = active ? '采集遇到问题' : '无法开始采集'; tone = 'error'; }
  else if (active) {
    if (status.state === 'paused') { label = '等待播放'; tone = 'waiting'; }
    else if (status.state === 'capturing') { label = '正在采集'; tone = 'active'; }
    else { label = '等待音频'; tone = 'waiting'; }
  }
  text('state', label);
  nodes.state.dataset.tone = tone;
  nodes.capture.setAttribute('aria-checked', String(active));
  nodes.capture.disabled = !currentState || busy || (!active && (!state.paired || !state.supported || !!state.problem || !!connectionError));

  let notice = error;
  if (!notice && currentState && !active) notice = state.problem || (!state.paired ? '请先在“配对设置”连接本机服务。' : !state.supported ? '请在 F1 TV 节目标签页打开此面板。' : '');
  if (!notice && active) notice = status.message || (state.elsewhere ? '正在采集另一标签页。关闭此开关即可停止。' : '');
  if (!notice && status.state === 'error') notice = status.message;
  nodes.notice.hidden = !notice;
  nodes.notice.dataset.tone = error || status.state === 'error' ? 'error' : !active && notice ? 'waiting' : '';
  text('notice', notice || '');

  text('source-label', active && state.elsewhere ? '正在采集另一标签页' : active ? '正在采集的标签页' : '当前标签页');
  text('tab-title', safeTitle(active ? state.captureTitle || state.tabTitle : state.tabTitle));
  text('page-label', state.pageLabel || '—');
  text('audio-label', state.audioLabel || '—');
  text('programme-time', timeLabel(state.programmeTime));
  text('received', metric(status.receivedSeconds, '秒', 1));
  text('level', metric(status.audioDb, 'dBFS'));
  text('windows', metric(status.asrWindows, '段'));
  text('cues', metric(status.cueCount, '句'));
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
    actionError = '无法打开配对设置，请从扩展管理页打开设置。';
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
