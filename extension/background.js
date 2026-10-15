import { validCaptureSnapshot } from '../src/capture-protocol.js';
import { publicSettings, saveSettings } from './settings-store.js';
import { translateDirect } from './model-services.js';
import { installApiRouter, providerHealth, safeApiError } from './api-router.js';

installApiRouter({ ensureOffscreen });

const site = 'https://f1tv.formula1.com';
const offscreenUrl = chrome.runtime.getURL('offscreen.html');
const popupUrl = chrome.runtime.getURL('popup.html');
let creating, stopping, starting = false;
const current = async () => (await chrome.storage.session.get('capture')).capture;
const isSite = url => { try { return new URL(url).origin === site; } catch { return false; } };
const sendTab = (tabId, message) => chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
const offscreen = message => chrome.runtime.sendMessage({ to: 'offscreen', ...message });
const userError = message => Object.assign(Error(message), { userMessage: true });
async function ensureOffscreen() {
  if ((await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [offscreenUrl] })).length) return;
  creating ||= chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA', 'BLOBS'],
    justification: 'Process opted-in tab audio and send PCM audio blobs to the configured speech service.' });
  try { await creating; } finally { creating = null; }
}
async function show(tabId, value) {
  await Promise.allSettled([
    chrome.storage.session.set({ [`status:${tabId}`]: value }),
    chrome.action.setBadgeText({ tabId, text: value.active ? (value.state === 'paused' ? 'Ⅱ' : 'ON') : value.state === 'error' ? '!' : '' }),
    chrome.action.setBadgeBackgroundColor({ tabId, color: value.state === 'error' ? '#a13333' : '#246a85' }),
    chrome.action.setTitle({ tabId, title: value.message || '打开声音采集面板' }),
    sendTab(tabId, { type: 'status', ...value })
  ]);
}
async function stopCapture(message = '采集已关闭，标签页声音已恢复。', state = 'stopped') {
  if (stopping) return stopping;
  stopping = (async () => {
    const capture = await current();
    if (!capture) return;
    const result = await offscreen({ type: 'stop', id: capture.id }).catch(() => null);
    if (!result?.ok && capture.capturing) await chrome.offscreen.closeDocument().catch(() => {});
    if ((await current())?.id === capture.id) await chrome.storage.session.remove('capture');
    // OFF releases capture suppression and clears a mute left by an older
    // extension version. It never pauses the player.
    if (capture.capturing) await chrome.tabs.update(capture.tabId, { muted: false }).catch(() => {});
    await show(capture.tabId, { active: false, state, message });
  })();
  try { await stopping; } finally { stopping = null; }
}
async function panelState(tabId) {
  const capture = await current();
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const supported = isSite(tab?.url);
  const targetId = capture?.tabId ?? tabId;
  const snapshot = (capture || supported) ? await sendTab(targetId, { type: 'snapshot' }).catch(() => null) : null;
  const values = await chrome.storage.session.get(`status:${targetId}`);
  const config = await publicSettings();
  const problem = !supported && !capture ? '请在 F1 TV 页面打开面板。'
    : !snapshot || snapshot.protocol !== 1 || snapshot.client !== 'extension' ? '请停用旧油猴脚本，并刷新 F1 TV 页面以连接新版扩展。'
    : snapshot.startProblem || (!validCaptureSnapshot(snapshot) ? '等待官方节目时间。' : null);
  return { configured: config.translation.configured, asrConfigured: config.asr.enabled && config.asr.configured,
    supported, active: Boolean(capture), busy: starting || Boolean(stopping),
    elsewhere: Boolean(capture && capture.tabId !== tabId), tabTitle: tab?.title || '当前标签页',
    captureTitle: capture?.title || '', pageLabel: snapshot?.pageLabel || '', audioLabel: snapshot?.audioLabel || '',
    programmeTime: snapshot?.time ?? null, problem, status: values[`status:${targetId}`] || {} };
}
async function startCapture(tabId) {
  if (starting || stopping) return { ok: false, message: '正在切换采集状态，请稍候。' };
  starting = true;
  let capture;
  try {
    if (await current()) return { ok: false, message: '已有标签页正在采集，请先关闭采集开关。' };
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active || !isSite(tab.url)) throw userError('请在要采集的 F1 TV 标签页打开面板。');
    const config = await publicSettings();
    if (!config.translation.configured || !config.asr.enabled || !config.asr.configured) throw userError('请先在扩展设置中配置翻译和声音识别。');
    const snapshot = await sendTab(tab.id, { type: 'snapshot' }).catch(() => null);
    if (snapshot?.protocol !== 1 || snapshot.client !== 'extension') throw userError('请停用旧油猴脚本，并刷新 F1 TV 页面。');
    if (snapshot.startProblem) throw userError(snapshot.startProblem);
    if (!validCaptureSnapshot(snapshot)) throw userError('等待官方播放器提供有效的节目时间。');
    capture = { id: crypto.randomUUID(), tabId: tab.id, title: tab.title || 'F1 TV',
      programmeId: snapshot.programmeId, capturing: false };
    await chrome.storage.session.set({ capture });
    await show(tab.id, { active: true, state: 'starting', message: '正在接入标签页声音…' });
    await ensureOffscreen();
    if ((await current())?.id !== capture.id) return { ok: false };
    const latest = await chrome.tabs.get(tab.id);
    if (latest.url !== tab.url) throw userError('页面已切换，请在当前页面重新打开采集。');
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    if ((await current())?.id !== capture.id) return { ok: false };
    capture.capturing = true;
    await chrome.storage.session.set({ capture });
    const result = await offscreen({ type: 'start', capture, streamId, snapshot });
    if (!result?.ok) throw userError(result?.message || '未能接入声音，请关闭后重试。');
    if ((await current())?.id !== capture.id || stopping) {
      await stopping; await offscreen({ type: 'stop', id: capture.id }); return { ok: false };
    }
    // tabCapture owns suppression; never mute the tab to implement the switch.
    await chrome.tabs.update(tab.id, { muted: false });
    return { ok: true };
  } catch (error) {
    const message = error?.userMessage ? error.message : '未能连接采集页，请刷新页面并检查扩展设置。';
    if (capture?.id && (await current())?.id === capture.id) await stopCapture(message, 'error');
    else await show(tabId, { active: false, state: 'error', message });
    return { ok: false, message };
  } finally { starting = false; }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.to !== 'background' || sender.id !== chrome.runtime.id) return;
  const fromPage = sender.tab && sender.frameId === 0 && isSite(sender.url);
  const fromOffscreen = !sender.tab && sender.url === offscreenUrl;
  const fromPopup = !sender.tab && sender.url === popupUrl;
  const fromOptions = sender.url === chrome.runtime.getURL('options.html');
  if (!fromPage && !fromOffscreen && !fromPopup && !fromOptions) return;
  const run = async () => {
    if (fromOptions && message.type === 'get-config') return publicSettings();
    if (fromOptions && message.type === 'save-config') {
      if (await current()) return { ok: false, code: 'CONFIG_BUSY', message: '请先关闭声音采集，再修改模型配置。' };
      try {
        const config = await saveSettings(message.config);
        const health = await providerHealth();
        const tabs = await chrome.tabs.query({ url: `${site}/*` });
        await Promise.allSettled(tabs.map(tab => sendTab(tab.id, { type: 'config-changed', health })));
        return { ok: true, config };
      } catch (error) { return { ok: false, ...safeApiError(error) }; }
    }
    if (fromOptions && message.type === 'test-translation') {
      const began = performance.now();
      try {
        const value = await translateDirect({ cue: { id: 'settings-test', text: 'Box this lap.', start: 0, end: 3 }, context: [] });
        return { ok: true, text: value.text, elapsedMs: Math.round(performance.now() - began) };
      } catch (error) { return { ok: false, ...safeApiError(error) }; }
    }
    if (fromPopup && message.type === 'panel-state' && Number.isInteger(message.tabId)) return panelState(message.tabId);
    if (fromPopup && message.type === 'start' && Number.isInteger(message.tabId)) return startCapture(message.tabId);
    const capture = await current();
    if (message.type === 'stop' && (fromPopup || fromOptions || (fromPage && sender.tab.id === capture?.tabId))) {
      await stopCapture(); return { ok: true };
    }
    if (!capture) return null;
    if (fromOffscreen && message.id !== capture.id) return null;
    if (fromOffscreen && message.type === 'clock') return sendTab(capture.tabId, { type: 'snapshot' });
    if (fromOffscreen && message.type === 'failed') { await stopCapture(message.message, 'error'); return null; }
    if (fromOffscreen && message.type === 'status') { await show(capture.tabId, { ...message.status, active: true }); return null; }
    if (fromPage && message.type === 'clock-changed' && sender.tab.id === capture.tabId) return offscreen({ type: 'clock-changed', id: capture.id });
    if (message.type !== 'relay' || message.packet?.programmeId !== capture.programmeId) return null;
    if (fromPage) return offscreen({ type: 'relay', id: capture.id, packet: message.packet });
    if (fromOffscreen) {
      // Receiving scripts select their programme/mode; extension doesn't.
      const tabs = await chrome.tabs.query({ url: `${site}/*` });
      await Promise.allSettled(tabs.map(tab => sendTab(tab.id, { type: 'relay', packet: message.packet })));
    }
    return null;
  };
  void run().then(respond, () => respond(null)); return true;
});
chrome.tabs.onRemoved.addListener(tabId => {
  void current().then(async capture => {
    if (capture?.tabId === tabId) await stopCapture('采集标签页已关闭。');
    await chrome.storage.session.remove(`status:${tabId}`);
  });
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url && change.status !== 'loading') return;
  void current().then(capture => {
    if (capture?.tabId === tabId) return stopCapture('采集页已刷新或切换，请准备后重新打开采集开关。');
  });
});
chrome.tabCapture.onStatusChanged.addListener(info => {
  if (!['stopped', 'error'].includes(info.status) || stopping) return;
  void current().then(capture => {
    if (capture?.tabId === info.tabId) return stopCapture('浏览器声音捕获已结束，请重新打开采集开关。', 'error');
  });
});
