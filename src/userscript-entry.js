import { CueStore, TranslationQueue, SubtitleTimeline, sameSpeech } from './core.js';
import { TextTrackSource } from './sources.js';
import { VideoOverlay, normalizeSubtitleStyle } from './overlay.js';
import { FloatingControls } from './floating-controls.js';
import { TiledMediaVodSource, tiledContentSeconds, OfficialCaptionVisibility } from './tiledmedia-source.js';
import { TiledMediaLiveSource, tiledLiveOriginSeconds } from './tiledmedia-live-source.js';
import { TrackFxSource, TrackFxContinuousSource } from './track-fx-source.js';
import { createAsrRequester } from './asr-client.js';
import { createRadioClient } from './radio-client.js';
import { commentaryPreparation } from './preparation-state.js';
import { postExtensionMessage, listenExtensionMessages, createExtensionRelayChannel, extensionSnapshotFailure } from './extension-bridge.js';
import { ProgrammeRelay } from './programme-relay.js';
import { capturePageInfo, captureStartProblem } from './capture-mode.js';

const SERVICE = 'http://127.0.0.1:3847';
const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
let token = GM_getValue('localServiceToken', '');
const PREPARATION_SECONDS = 45;
const PREPARATION_LOOKAHEAD = 60;
// Historical 30 s samples needed up to 12.26 s AFTER capture to recognize and
// translate. This is a starting allowance, not a measured live latency bound.
const LIVE_VIEW_DELAY_SECONDS = 50;
const savedTransparency = Number(GM_getValue('subtitleTransparency', 0));
let subtitleTransparency = Number.isFinite(savedTransparency) ? Math.max(0, Math.min(100, savedTransparency)) : 0;
let subtitleStyle = normalizeSubtitleStyle(GM_getValue('subtitleStyle', {}));
let subtitlePosition = GM_getValue('subtitlePosition', null);
let session = null;
let collectorSession = null;
let extensionBridgeIssue = null;
let collectorWindow = null;
let collectorWindowProgrammeId = null;
const collectorMode = ['f1zh-capture', 'f1zh-audio'].some(key => new URL(location.href).searchParams.get(key) === '1');
const replaySimulation = new URL(location.href).searchParams.get('f1zh-replay') === '1';
let enabled = false;
let radioEnabled = false;
let currentPage = location.href;
const panel = document.createElement('div'); panel.dataset.f1zh = 'controls';
panel.style.cssText = 'position:fixed;right:18px;top:18px;z-index:2147483647;';
const shadow = panel.attachShadow({mode:'open'});
shadow.innerHTML = `<style>
:host{all:initial;color-scheme:dark}[hidden]{display:none!important}*{box-sizing:border-box}
section{color:#E5EDF4;background:#162331fa;border:1px solid #33495E;border-radius:12px;padding:18px;font:400 13px/1.6 "Microsoft YaHei",system-ui,sans-serif;width:min(340px,calc(100vw - 16px));max-height:calc(100vh - 16px);overflow:auto;box-shadow:0 12px 36px #0003;font-synthesis:none}
button,input,select{font:inherit}button{cursor:pointer;background:#1D2C3C;border:1px solid #33495E;border-radius:8px;color:#E5EDF4;padding:9px 12px;transition:background .15s,border-color .15s}
button:hover:enabled{background:#263A4B;border-color:#577387}button:disabled{cursor:default;opacity:.5}button:focus-visible,summary:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid #83DCC5;outline-offset:3px}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;cursor:grab;touch-action:none;user-select:none}h1{margin:0;font-size:20px;line-height:1.4;font-weight:400}.eyebrow{color:#A9BACB;font-size:11px;margin:0 0 3px}
p{margin:0;overflow-wrap:anywhere}small,.muted{color:#A9BACB}.role-description{color:#A9BACB;font-size:12px;margin:0 0 16px}
#minimize{flex:none;margin:0;padding:0;width:30px;height:30px;font-size:20px;line-height:1}
.switches{border:1px solid #33495E;border-radius:10px;background:#1D2C3C;padding:0 12px;margin-bottom:14px}.switch-control{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;padding:13px 0;border:0;border-radius:0;background:transparent;text-align:left}.switch-control+button{border-top:1px solid #33495E}.switch-control:hover:enabled{background:transparent}.switch-control:focus-visible{outline-offset:1px;border-radius:6px}
.switch-track{display:block;flex:none;width:42px;height:24px;padding:3px;border-radius:20px;background:#405365;transition:background .15s}.switch-track i{display:block;width:18px;height:18px;border-radius:50%;background:#C4D0DC;transition:transform .15s}.switch-control[aria-checked=true] .switch-track{background:#83DCC5}.switch-control[aria-checked=true] .switch-track i{background:#162331;transform:translateX(18px)}
#preparation{display:flex;align-items:center;gap:8px;width:100%;font-weight:400;background:#1D2C3C;color:#A9BACB;border:1px solid #33495E;border-radius:8px;padding:10px 12px}#preparation:before{content:"";flex:none;width:7px;height:7px;border-radius:50%;background:currentColor}
#preparation[data-state=preparing]{color:#C8D7E4}#preparation[data-state=ready]{color:#83DCC5;background:#83DCC50c;border-color:#83DCC540}
#preparation-detail{color:#A9BACB;font-size:12px;margin:9px 0 0;font-variant-numeric:tabular-nums}#status,#radio-status{color:#A9BACB;font-size:12px;line-height:1.7;margin-top:9px}#status:empty,#radio-status:empty{display:none}#radio-status{border-top:1px solid #33495E;padding-top:9px}.translation-issue{margin-top:10px;padding:9px 11px;border:1px solid #D8BB8540;border-radius:8px;color:#E4C791;background:#D8BB850a;font-size:12px}
details{margin:14px 0 0;border:1px solid #33495E;border-radius:10px;padding:10px 12px;background:#1D2C3C}summary{cursor:pointer;user-select:none}.style-option,.opacity{display:flex;align-items:center;gap:10px;margin:12px 0;font-size:12px}.style-option select{flex:1;min-width:0;background:#162331;color:#E5EDF4;border:1px solid #33495E;border-radius:6px;padding:5px 7px}.style-option input[type=range],.opacity input{flex:1;min-width:0;accent-color:#83DCC5}.style-option input[type=checkbox]{accent-color:#83DCC5}.style-option output,.opacity output{min-width:4ch;text-align:right;font-variant-numeric:tabular-nums}details small{display:block;font-size:11px;line-height:1.7}
.panel-action{width:100%;margin-top:10px}.panel-action.primary{border-color:#83DCC570;color:#83DCC5;background:#83DCC50a}.panel-action.primary:hover:enabled{border-color:#83DCC5;background:#83DCC516}.playback-status{color:#A9BACB;font-size:11px;margin-top:6px}.secondary-details{padding:8px 0;background:transparent;border:0;color:#A9BACB;font-size:12px}.secondary-details .panel-action{font-size:12px}.secondary-details p{margin-top:8px}
.capture-hint{color:#A9BACB;font-size:11px;line-height:1.7;margin-top:14px;padding-top:12px;border-top:1px solid #33495E}.panel-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:12px;font-size:11px;color:#A9BACB}.text-button{border:0;padding:2px 0;background:transparent;color:#A9BACB;font-size:12px}.text-button:hover:enabled{background:transparent;color:#83DCC5}.panel-footer span{font-variant-numeric:tabular-nums}
#ball{display:grid;place-items:center;width:40px;height:40px;margin:0;padding:0;border-radius:50%;background:#162331f5;border:1px solid #33495E;color:#83DCC5;box-shadow:0 3px 12px #0003;font:400 15px "Microsoft YaHei",sans-serif;cursor:grab;touch-action:none;user-select:none}:host([data-dragging]) header,:host([data-dragging]) #ball{cursor:grabbing}
@media(prefers-reduced-motion:reduce){button,.switch-track,.switch-track i{transition:none}}
</style><section id="console" aria-label="F1 TV 字幕控制台"><header id="drag-handle" title="拖动标题栏移动控制台"><div><p class="eyebrow">F1 TV 中文</p><h1 id="console-title">中文字幕</h1></div><button id="minimize" type="button" aria-label="最小化控制台" title="最小化为悬浮球">−</button></header><div class="switches"><button id="toggle" class="switch-control" type="button" role="switch" aria-label="中文字幕" aria-checked="false"><span>中文字幕</span><span class="switch-track" aria-hidden="true"><i></i></span></button><button id="radio-toggle" class="switch-control" type="button" role="switch" aria-label="TR 与采访字幕" aria-checked="false" disabled><span>TR / 采访</span><span class="switch-track" aria-hidden="true"><i></i></span></button></div><div id="preparation" data-state="waiting" role="status" aria-live="polite">字幕已关闭</div><p id="preparation-detail">开启后准备解说中文，目标 45 秒</p><label class="opacity" for="transparency" title="文字和底色一起变透明；0% 最清晰，100% 完全透明">透明度<input id="transparency" type="range" min="0" max="100" step="5"><output id="transparency-value" for="transparency"></output></label><p id="status">翻译已关闭</p><div id="panel-footer" class="panel-footer"><button id="pair" class="text-button" type="button">配对本机服务</button><span>v0.9.1</span></div></section><button id="ball" hidden aria-label="展开字幕控制台" title="点击展开；拖动后吸附左右边缘">中</button>`;
document.body.append(panel);
// Slider/button keyboard input belongs to this console, not the site's video shortcuts.
panel.addEventListener('keydown', event => event.stopPropagation());
panel.addEventListener('keyup', event => event.stopPropagation());
const button = shadow.getElementById('toggle'), status = shadow.getElementById('status');
const pairButton = shadow.getElementById('pair');
const radioButton = shadow.getElementById('radio-toggle');
const preparationButton = shadow.getElementById('preparation');
const preparationDetail = shadow.getElementById('preparation-detail');
const radioStatus = document.createElement('p');
radioStatus.id = 'radio-status';
radioStatus.textContent = 'TR / 采访随中文字幕开启，可单独开关';
status.after(radioStatus);
const collectorButton = document.createElement('button');
collectorButton.id = 'live-audio'; collectorButton.hidden = true;
collectorButton.textContent = '打开声音采集页';
collectorButton.className = 'panel-action primary';
collectorButton.title = '另开同一节目准备 Track FX；本页继续英语解说。声音采集由扩展面板开关控制';
radioStatus.after(collectorButton);
const playbackButton = document.createElement('button');
playbackButton.id = 'prepare-playback'; playbackButton.className = `panel-action${collectorMode ? ' primary' : ''}`;
playbackButton.textContent = collectorMode ? '准备 Track FX 并播放' : '预留 50 秒翻译时间';
playbackButton.title = collectorMode ? '选择 Track FX 并播放；随后在扩展面板中打开采集开关'
  : '调整观看位置到直播后方 50 秒；保留暂停或播放状态，不改变字幕时间戳';
collectorButton.after(playbackButton);
const replayOptions = document.createElement('details');
replayOptions.className = 'secondary-details'; replayOptions.hidden = true;
replayOptions.innerHTML = '<summary>用录播测试 TR</summary><p>没有直播时，可用同一段录播检查声音采集与字幕。此功能可选；切换模式会刷新当前页。</p>';
const replayButton = document.createElement('button');
replayButton.textContent = replaySimulation ? '退出录播测试' : '开始录播测试'; replayButton.hidden = true;
replayButton.className = 'panel-action'; replayOptions.append(replayButton);
playbackButton.after(replayOptions);
replayButton.addEventListener('click', () => {
  // A visible opt-in, before enabling translation, prevents VOD prefetch from
  // being mistaken for evidence that the extension captured the tab's audio.
  const url = new URL(location.href);
  if (replaySimulation) url.searchParams.delete('f1zh-replay');
  else url.searchParams.set('f1zh-replay', '1');
  url.searchParams.delete('f1zh-commentary');
  url.searchParams.delete('f1zh-capture'); url.searchParams.delete('f1zh-audio');
  setEnabled(false); location.href = url.href;
});
const playbackStatus = document.createElement('p');
playbackStatus.className = 'playback-status';
playbackButton.after(playbackStatus);
const roleDescription = document.createElement('p');
roleDescription.className = 'role-description';
roleDescription.textContent = collectorMode ? '采集页 · 只负责准备音轨，采集开关在扩展面板'
  : `${replaySimulation ? '回放模拟 · ' : ''}观看页 · English F1 Live + 英文字幕`;
shadow.querySelector('header').after(roleDescription);
const captureHint = document.createElement('p');
captureHint.className = 'capture-hint';
captureHint.textContent = '关闭字幕不会停止声音采集；请在扩展面板关闭采集开关。';
shadow.getElementById('panel-footer').before(captureHint);
const translationIssue = document.createElement('p');
translationIssue.hidden = true; translationIssue.className = 'translation-issue'; translationIssue.setAttribute('role', 'status');
status.after(translationIssue);
const translationMessages = {
  UNAUTHORIZED: '本机配对已失效，请点击下方“重新配对本机服务”。',
  LOCAL_SERVICE_UNAVAILABLE: '本机翻译服务连接失败，请打开 127.0.0.1:3847 检查服务是否运行。',
  LOCAL_SERVICE_TIMEOUT: '本机翻译请求超时，当前句保留英文。',
  BUSY: '本机翻译队列繁忙，当前句保留英文。',
  UPSTREAM_AUTH_FAILED: '翻译 API 认证失败，请检查本机密钥配置。',
  UPSTREAM_BALANCE: '翻译 API 返回余额不足（402）。',
  UPSTREAM_RATE_LIMITED: '翻译 API 返回限流（429），当前句保留英文；稍后关闭再开启翻译重试。',
  UPSTREAM_UNAVAILABLE: '本机服务无法连接翻译 API，或 API 暂时不可用。',
  UPSTREAM_REJECTED: '翻译 API 拒绝请求，请检查接口和模型配置。',
  TRANSLATION_TIMEOUT: '翻译 API 响应超时，当前句保留英文。',
  INVALID_UPSTREAM_RESPONSE: '翻译 API 未返回有效译文，当前句保留英文。'
};
function showTranslationIssue(code) {
  translationIssue.textContent = code ? translationMessages[code] || '翻译请求失败，当前句保留英文。' : '';
  translationIssue.hidden = !code;
}
const transparency = shadow.getElementById('transparency');
const transparencyValue = shadow.getElementById('transparency-value');
const stylePanel = document.createElement('details');
stylePanel.id = 'subtitle-style';
stylePanel.innerHTML = `<summary>字幕样式</summary><label class="style-option" for="subtitle-font">字体<select id="subtitle-font"><option value="yahei">微软雅黑</option><option value="heiti">黑体</option><option value="songti">宋体</option><option value="system">系统默认</option></select></label><label class="style-option" for="subtitle-size">字号<input id="subtitle-size" type="range" min="16" max="48" step="1"><output id="subtitle-size-value"></output></label><label class="style-option"><input id="subtitle-bold" type="checkbox">加粗</label><small>拖动任一字幕可一起移动；设置自动保存。</small>`;
const opacityRow = transparency.closest('label');
collectorButton.before(stylePanel); stylePanel.insertBefore(opacityRow, stylePanel.lastElementChild);
if (collectorMode) {
  shadow.getElementById('console-title').textContent = '声音采集';
  shadow.querySelector('.switches').hidden = true;
  radioButton.hidden = true; stylePanel.hidden = true;
  status.textContent = replaySimulation ? '先定位回放起点，再准备 Track FX。'
    : '先在官网选择 WATCH LIVE，再准备 Track FX。';
  radioStatus.textContent = '扩展面板显示声音输入、识别进度和中文缓存。';
  captureHint.textContent = '准备音轨会出声；扩展开启采集后本页静音，关闭采集后恢复声音。';
}
const fontControl = shadow.getElementById('subtitle-font'), sizeControl = shadow.getElementById('subtitle-size');
const boldControl = shadow.getElementById('subtitle-bold'), sizeValue = shadow.getElementById('subtitle-size-value');
fontControl.value = subtitleStyle.font; sizeControl.value = String(subtitleStyle.size); boldControl.checked = subtitleStyle.bold;
sizeValue.value = `${subtitleStyle.size}px`;
for (const control of [fontControl, sizeControl, boldControl]) {
  control.addEventListener('input', () => {
    subtitleStyle = normalizeSubtitleStyle({ font: fontControl.value, size: Number(sizeControl.value), bold: boldControl.checked });
    sizeValue.value = `${subtitleStyle.size}px`; session?.overlay.setStyle(subtitleStyle);
  });
  control.addEventListener('change', () => GM_setValue('subtitleStyle', subtitleStyle));
}
transparency.value = String(subtitleTransparency);
transparencyValue.value = `${subtitleTransparency}%`;
transparency.addEventListener('input', () => {
  subtitleTransparency = Number(transparency.value);
  transparencyValue.value = `${subtitleTransparency}%`;
  session?.overlay.setOpacity(1 - subtitleTransparency / 100);
});
transparency.addEventListener('change', () => GM_setValue('subtitleTransparency', subtitleTransparency));
const floatingControls = new FloatingControls(panel, {
  panel: shadow.getElementById('console'), handle: shadow.getElementById('drag-handle'),
  minimize: shadow.getElementById('minimize'), ball: shadow.getElementById('ball'),
  saved: GM_getValue(collectorMode ? 'collectorConsole' : 'floatingConsole', null),
  onSave: value => GM_setValue(collectorMode ? 'collectorConsole' : 'floatingConsole', value)
});

function preparationFor(current = session) {
  const time = current?.view ? tiledContentSeconds(current.view) : current?.video.currentTime;
  const source = current?.source;
  const cues = current ? current.store.sorted() : [];
  // Only confirmed source coverage can count silence as prepared time.
  const coverage = current?.sourceKind === 'native' ? cues.map(c => [c.start, c.end])
    : !source?.validated ? [] : source.coverage || [[source.coverageStart, source.coverageEnd]];
  return commentaryPreparation({enabled, time, coverage, cues, targetSeconds:PREPARATION_SECONDS});
}
function refreshControls() {
  refreshPlaybackStatus();
  pairButton.textContent = token ? '重新配对本机服务' : '配对本机服务';
  if (collectorMode) { refreshCollectorControls(); return; }
  button.setAttribute('aria-checked', String(enabled));
  button.title = enabled ? '关闭全部中文字幕；声音采集不受影响' : '开启中文字幕';
  radioButton.setAttribute('aria-checked', String(radioEnabled));
  radioButton.disabled = !enabled; radioButton.hidden = false;
  radioButton.title = enabled ? '只控制 TR / 采访中文字幕；不改变扩展采集开关' : '开启中文字幕后，可单独控制 TR / 采访';
  const prep = preparationFor();
  preparationButton.dataset.state = prep.state;
  const preparationLabel = !enabled ? '字幕已关闭' : {waiting:'等待解说字幕', preparing:'正在准备解说中文', ready:'解说中文已就绪'}[prep.state];
  if (preparationButton.textContent !== preparationLabel) preparationButton.textContent = preparationLabel;
  preparationDetail.textContent = !enabled ? '开启后准备解说中文，目标 45 秒'
    : !session ? '等待播放器，解说中文目标 45 秒'
    : prep.state === 'ready' ? `解说中文已连续准备 ${Math.floor(prep.ahead)} 秒${session.video.paused ? ' · 等待播放' : ''}`
    : `解说中文连续就绪 ${Math.floor(prep.ahead)} / 45 秒${session.video.paused ? '' : ' · 播放中继续准备'}`;
  preparationButton.title = '仅统计观看位置前方已翻译好的连续解说字幕；TR及采访不影响准备状态';
  const collectorAvailable = session?.sourceKind === 'live' || (replaySimulation && session?.sourceKind === 'vod');
  collectorButton.hidden = !session;
  collectorButton.disabled = !collectorAvailable;
  collectorButton.title = collectorAvailable ? '另开本场采集页；准备 Track FX 后，由扩展开关开始采集'
    : session?.sourceKind === 'vod' ? '如需测试 TR，请先展开下方“用录播测试 TR”，再打开采集页' : '等待官网播放器提供可采集的节目';
  captureHint.hidden = !replaySimulation && pageWindow.document.querySelector('tiledmedia-view')?.currentContentTime?.eventType !== 'live';
  if (session?.radio?.usingRelay) refreshRelayStatus(session);
}
function waitWhenPrepared(source, current) {
  const poll = source.poll.bind(source);
  source.poll = () => {
    if (session !== current || !enabled) return;
    if (current.video.paused && preparationFor(current).state === 'ready') return;
    return poll();
  };
}
refreshControls();

function requestTranslation(cue, context, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(Error('cancelled'));
    let finished = false;
    const done = (error, value) => {
      if (finished) return;
      finished = true; signal.removeEventListener('abort', abort);
      if (error !== 'CANCELLED') showTranslationIssue(error);
      error ? reject(Error('translation_unavailable')) : resolve(value);
    };
    let request;
    const abort = () => { request?.abort(); done('CANCELLED'); };
    signal.addEventListener('abort', abort, {once:true});
    try { request = GM_xmlhttpRequest({ method:'POST', url:`${SERVICE}/api/translate`, anonymous:true,
      headers:{'Content-Type':'application/json', Authorization:`Bearer ${token}`},
      data:JSON.stringify({cue,context}), timeout:11500,
      onload: response => {
        let body;
        try { body = JSON.parse(response.responseText); } catch { return done('INVALID_UPSTREAM_RESPONSE'); }
        if (response.status !== 200) return done(response.status === 401 ? 'UNAUTHORIZED' : body?.error?.code || 'REQUEST_FAILED');
        if (typeof body?.text !== 'string' || !body.text.trim()) return done('INVALID_UPSTREAM_RESPONSE');
        done(null, body);
      }, onerror:()=>done('LOCAL_SERVICE_UNAVAILABLE'), ontimeout:()=>done('LOCAL_SERVICE_TIMEOUT'), onabort:()=>done('CANCELLED')
    }); } catch { done('LOCAL_SERVICE_UNAVAILABLE'); }
  });
}
const radioClient = createRadioClient(GM_xmlhttpRequest, { service:SERVICE, getToken:()=>token });
const requestAsr = createAsrRequester(GM_xmlhttpRequest, { service:SERVICE, getToken:()=>token });
function programmeRelayId(view) {
  const page = capturePageInfo(location.href), kind = view?.currentContentTime?.eventType;
  return page && kind === (page.replay ? 'vod' : 'live') ? page.programmeId : null;
}
function relayClockOrigin(view) {
  return replaySimulation && view?.currentContentTime?.eventType === 'vod' ? 0 : tiledLiveOriginSeconds(view);
}
function behindLiveSeconds(view) {
  const clock = view?.currentContentTime;
  return clock?.eventType === 'live' && Number.isFinite(clock.seekUpperBound) && Number.isFinite(clock.currentPosition)
    ? Math.max(0, (clock.seekUpperBound - clock.currentPosition) / 1000) : NaN;
}
function refreshPlaybackStatus() {
  const view = pageWindow.document.querySelector('tiledmedia-view');
  replayButton.hidden = collectorMode || view?.currentContentTime?.eventType !== 'vod';
  replayOptions.hidden = replayButton.hidden;
  if (replaySimulation && view?.currentContentTime?.eventType === 'vod') {
    playbackButton.hidden = !collectorMode || enabled;
    playbackButton.title = '保持当前节目位置，切到 Track FX 并以 1 倍速播放';
    playbackStatus.textContent = collectorMode ? '回放模拟：按本页正在播放的声音采集，不下载未来音轨'
      : '回放模拟：TR 只接收扩展结果；观看页先暂停，让采集页领先约 50 秒';
    return;
  }
  const lag = behindLiveSeconds(view);
  playbackButton.hidden = collectorMode ? enabled || !view?.associatedPlayer : !Number.isFinite(lag);
  if (playbackButton.disabled) return;
  playbackStatus.textContent = !Number.isFinite(lag) ? (collectorMode ? '等待官网直播播放器' : '')
    : collectorMode ? `距官方直播前沿约 ${Math.round(lag)} 秒 · 无人说话时也继续采集`
    : `观看位置落后官方直播前沿约 ${Math.round(lag)} 秒 · 暂建议 ${LIVE_VIEW_DELAY_SECONDS} 秒`;
}
async function seekLivePosition(view, delay, resume, stillActive = () => true) {
  const clock = view?.currentContentTime, player = view?.associatedPlayer;
  if (clock?.eventType !== 'live' || !Number.isFinite(clock.seekUpperBound) || !Number.isFinite(clock.seekLowerBound)
      || !player || !pageWindow.Tiledmedia?.TimingConfig) throw Error('等待官方直播时间就绪');
  const target = clock.seekUpperBound - delay * 1000;
  if (target < clock.seekLowerBound) throw Error('当前直播可回看范围不足，请稍后再试');
  const config = new pageWindow.Tiledmedia.TimingConfig();
  config.timingType = 1; config.targetPositionStrategy = 1; config.target = target;
  await player.seek(config);
  // SDK seek may pause on its own. Restore only the explicitly requested state.
  if (stillActive() && view.isConnected && view.associatedPlayer === player) {
    if (resume) await player.unpause();
    else await player.pause();
  }
}
async function prepareCollectorPlayback() {
  const view = pageWindow.document.querySelector('tiledmedia-view'), player = view?.associatedPlayer;
  const replay = replaySimulation && view?.currentContentTime?.eventType === 'vod';
  if (!player || (!replay && view.currentContentTime?.eventType !== 'live')) throw Error('请先选择直播，或开启回放模拟模式');
  if (collectorSession) throw Error('请先在扩展面板关闭采集，再调整音轨。');
  const stream = await player.currentAudioTrack, track = await stream?.parentAudioTrack;
  const content = await stream?.parentContentItem || await track?.parentContentItem;
  let selected = /^track\s*fx$/i.test(await track?.name || '') ? track : null;
  for (const feedValue of selected ? [] : await content?.feeds || []) {
    const feed = await feedValue;
    for (const candidateValue of await feed.audioTracks || []) {
      const candidate = await candidateValue;
      if (/^track\s*fx$/i.test(await candidate.name || '') || /^fx$/i.test(await candidate.language || '')) { selected = candidate; break; }
    }
    if (selected) break;
  }
  if (!selected) throw Error('本节目尚未找到 Track FX，请在官网音轨菜单确认');
  player.desiredAudioTrackSelection = new pageWindow.Tiledmedia.AudioTrackSelection(false, selected);
  await player.applyDesiredState(pageWindow.Tiledmedia.DesiredStateConfig.maintainPosition());
  await player.changePlaybackRate(1);
  await player.setAudioGain(1); await player.setAudioIsMuted(false);
  const video = view.querySelector('video');
  if (video) { video.muted = false; video.volume = 1; }
  if (replay) await player.unpause();
  else await seekLivePosition(view, 3, true);
  status.textContent = 'Track FX 已开始播放；打开扩展面板，将“采集声音”开关打开。';
}
function refreshCollectorControls() {
  if (extensionBridgeIssue) {
    preparationButton.dataset.state = 'preparing'; preparationButton.textContent = '扩展连接需恢复';
    preparationDetail.textContent = extensionBridgeIssue;
    return;
  }
  const current = collectorSession, paused = current?.lastStatus?.state === 'paused';
  const starting = current?.lastStatus?.state === 'starting';
  preparationButton.dataset.state = !enabled ? 'waiting' : paused || starting ? 'preparing' : 'ready';
  preparationButton.textContent = !enabled ? '采集开关已关闭' : starting ? '正在接入声音' : paused ? '等待播放' : '正在采集';
  preparationButton.title = '扩展独立处理音频；播放器须保持真实播放';
  preparationDetail.textContent = enabled ? '开关已开 · 关闭扩展面板仍会继续采集'
    : '先准备音轨，再在扩展面板打开采集开关';
}
function stopCollector(message = '采集页已变化，正在停止采集并恢复标签页声音。') {
  postExtensionMessage({ type: 'stop' });
  collectorSession = null; enabled = false;
  status.textContent = message; refreshControls();
}
let collectorClockEpoch = 0, collectorClockRefs = null;
const collectorObservedVideos = new WeakSet();
async function collectorSnapshot() {
  const view = pageWindow.document.querySelector('tiledmedia-view'), video = view?.querySelector('video');
  const page = capturePageInfo(location.href);
  const meta = { protocol: 1, pageLabel: `${replaySimulation ? '回放模拟' : view?.currentContentTime?.eventType === 'live' ? '直播' : '回放'} · ${collectorMode ? '采集页' : '观看页'}`, problem: null };
  if (!collectorMode) return { ...meta, startProblem: '这是观看页；请在脚本控制台打开声音采集页，并在新页准备 Track FX。' };
  const player = await view?.associatedPlayer;
  const audio = await player?.currentAudioTrack, track = await audio?.parentAudioTrack;
  const name = await track?.name, language = await track?.language;
  if (!video || !view.isConnected || view.associatedPlayer !== player) return { ...meta, startProblem: '等待官网播放器加载，请先打开本场节目。' };
  const refs = [view, video, player, audio];
  if (!collectorClockRefs || refs.some((item, index) => item !== collectorClockRefs[index])) {
    collectorClockEpoch++; collectorClockRefs = refs;
  }
  if (!collectorObservedVideos.has(video)) {
    collectorObservedVideos.add(video);
    for (const type of ['pause', 'play', 'seeking', 'seeked', 'waiting', 'playing', 'ratechange', 'volumechange', 'emptied']) {
      video.addEventListener(type, () => {
        // Preserve evidence of a pause/stall even if its message arrives after
        // playback has resumed. Internal video seeking is checked by SDK time.
        if (['pause', 'waiting', 'emptied'].includes(type)) collectorClockEpoch++;
        postExtensionMessage({ type: 'clock-changed' });
      });
    }
  }
  const snapshot = { ...meta, collector: true, audioLabel: name || language || '未选音轨', programmeId: programmeRelayId(view), epoch: collectorClockEpoch, eventType: view.currentContentTime?.eventType,
    time: tiledContentSeconds(view), origin: relayClockOrigin(view), at: performance.timeOrigin + performance.now(),
    trackFx: /^track\s*fx$/i.test(name || '') || /^fx$/i.test(language || ''),
    paused: video.paused, muted: video.muted || video.volume === 0, rate: Number(view.playbackRate) || 1,
    behindLive: behindLiveSeconds(view) };
  snapshot.startProblem = captureStartProblem(page, snapshot);
  snapshot.problem = !snapshot.trackFx ? '音轨已改变，请在脚本中准备 Track FX 后重新采集。'
    : snapshot.muted ? '官网播放器已静音，请恢复正常音量后重新采集。'
    : Math.abs(snapshot.rate - 1) > .01 ? '请将采集页恢复为 1 倍速后重新采集。' : null;
  return snapshot;
}
listenExtensionMessages(message => {
  if (message.type === 'bridge-unavailable') {
    extensionBridgeIssue = message.reason === 'context-invalidated'
      ? '扩展已重新加载，请刷新本页以恢复连接。' : '扩展通信暂时失败，请重新打开面板检查连接。';
    if (collectorMode) { status.textContent = extensionBridgeIssue; refreshControls(); }
    else if (session?.radio?.usingRelay) refreshRelayStatus(session);
    return;
  }
  if (message.type === 'installed') extensionBridgeIssue = null;
  if (message.type === 'snapshot-request') {
    void collectorSnapshot().then(snapshot => postExtensionMessage({ type: 'snapshot', requestId: message.requestId, snapshot }),
      () => postExtensionMessage({ type: 'snapshot', requestId: message.requestId, snapshot: extensionSnapshotFailure(collectorMode) }));
  }
  if (!collectorMode) {
    if (message.type === 'status' && message.state === 'error') radioStatus.textContent = message.message;
    return;
  }
  if (message.type === 'installed' && !enabled) {
    status.textContent = '扩展已连接；准备 Track FX 后，在扩展面板打开采集开关。';
  }
  if (message.type !== 'status') return;
  enabled = message.active === true;
  const view = pageWindow.document.querySelector('tiledmedia-view'), video = view?.querySelector('video');
  if (enabled && view && video) {
    collectorSession ||= { view, video, programmeId: programmeRelayId(view), lastLiveSeek: Date.now() };
    collectorSession.lastStatus = message;
  } else collectorSession = null;
  status.textContent = message.message || '等待扩展采集';
  radioStatus.textContent = enabled ? '音频、识别和中文缓存进度请看扩展面板。' : '采集关闭，标签页正常出声。';
  refreshControls();
});
postExtensionMessage({ type: 'hello' });
function tickCollector() {
  const current = collectorSession;
  if (!current) return;
  if (!current.video.isConnected || programmeRelayId(current.view) !== current.programmeId) {
    stopCollector('采集播放器已切换，请准备本场 Track FX，再在扩展面板打开采集开关。'); return;
  }
  // Only the collector's own distance from live can trigger a live seek. A
  // viewer pause, empty TR result or a missing heartbeat never does.
  if (!replaySimulation && !current.video.paused && behindLiveSeconds(current.view) > 20 && !current.seekingLive
      && Date.now() - current.lastLiveSeek > 30000) {
    current.lastLiveSeek = Date.now(); current.seekingLive = true;
    void seekLivePosition(current.view, 3, true, () => collectorSession === current)
      .catch(() => { if (collectorSession === current) status.textContent = '未能返回直播前沿；请关闭扩展采集，再点击“准备 Track FX 并播放”。'; })
      .finally(() => { current.seekingLive = false; });
  }
}
function refreshRelayStatus(current) {
  const radio=current?.radio, s=radio?.relayStatus;
  if (!radio?.usingRelay) return;
  if (extensionBridgeIssue) { radioStatus.textContent = `TR · ${extensionBridgeIssue}`; return; }
  const origin=relayClockOrigin(current.view), time=tiledContentSeconds(current.view);
  const gap=Number.isFinite(s?.contentTime)&&Number.isFinite(origin)?s.contentTime-origin-time:NaN;
  radioStatus.textContent=s?.state==='error'?`TR · ${s.message||'请检查采集页'}`
    : !s?.connected?'TR · 采集页已停止或断开，已收到的译文仍保留'
    : s.state==='paused'?`TR · ${s.message} · 已收到译文仍按时间显示`
    : `TR · ${replaySimulation ? '回放模拟' : '直播'}采集已连接 · 已缓存 ${radio.store.cues.size} 句${Number.isFinite(gap)?` · 领先 ${Math.round(gap)} 秒`:''}${Number.isFinite(gap)&&gap<45?' · 建议观看落后约50秒':''}`;
}
function connectProgrammeRelay(current) {
  const radio=current.radio, programmeId=programmeRelayId(current.view);
  if (!programmeId || !Number.isFinite(relayClockOrigin(current.view))) return;
  radio.relay=new ProgrammeRelay({programmeId,role:'viewer',channelFactory:()=>createExtensionRelayChannel(programmeId),
    onStatus:s=>{
      if(session!==current||current.radio!==radio)return;
      radio.relayStatus=s;
      // Completed translations remain useful across collector reconnection.
      if(s.connected && s.collectorId) radio.collectorId=s.collectorId;
      refreshRelayStatus(current);refreshControls();
    },
    onCues:cues=>{
      if(session!==current||current.radio!==radio||!radioEnabled)return;
      radio.queue.ingestMany(cues);
    }
  });
  radio.relay.setViewerState({contentTime:tiledContentSeconds(current.view)+relayClockOrigin(current.view),paused:current.video.paused,enabled:true});
}
function radioCapabilities() {
  return new Promise((resolve,reject)=>GM_xmlhttpRequest({method:'GET',url:`${SERVICE}/api/health`,anonymous:true,timeout:5000,
    onload:response=>{try {const value=JSON.parse(response.responseText);if(response.status!==200||value.service!=='f1tv-zh')throw Error();resolve(value);}catch{reject(Error('LOCAL_SERVICE_UNAVAILABLE'));}},
    onerror:()=>reject(Error('LOCAL_SERVICE_UNAVAILABLE')),ontimeout:()=>reject(Error('LOCAL_SERVICE_UNAVAILABLE'))
  }));
}
function stopRadio(current, notifyCollector = false) {
  if (!current?.radio) return;
  current.radio.relay?.close({disableViewer:notifyCollector});
  current.radio.source?.stop(); current.radio.queue.dispose(); current.radio.overlay.dispose();
  current.radio = null;
}
async function startRadio(current) {
  if (!radioEnabled || !current?.view || current.radio || current.radioStarting) return;
  if (current.sourceKind === 'live' || (replaySimulation && current.sourceKind === 'vod')) {
    const store = new CueStore({maxCues:1200}), timeline = new SubtitleTimeline(store, {exclusive:true});
    const getTime = () => tiledContentSeconds(current.view) + relayClockOrigin(current.view);
    timeline.setEnabled(true);
    // Ready Chinese arrives with absolute programme timestamps. Keep those
    // timestamps intact if the SDK later rebases its relative content clock.
    const queue = new TranslationQueue(store, requestTranslation, {getTime,contextWaitMs:0});
    const overlay = new VideoOverlay(current.video, timeline, {
      getTime, opacity:1-subtitleTransparency/100, above:current.overlay
    });
    current.radio = {store,timeline,queue,overlay,source:null,usingRelay:true};
    radioStatus.textContent='TR · 请打开声音采集页；本模式仅接收扩展结果';
    connectProgrammeRelay(current);
    refreshControls();
    return;
  }
  current.radioStarting = true;
  let direct;
  try { direct = (await radioCapabilities()).radio === true; }
  catch { if (session === current) radioStatus.textContent = 'TR · 本机语音服务连接失败'; return; }
  finally { current.radioStarting = false; }
  if (session !== current || !radioEnabled) return;
  const store = new CueStore(), timeline = new SubtitleTimeline(store, {exclusive:true});
  timeline.setEnabled(true);
  const queue = new TranslationQueue(store, requestTranslation, {
    concurrency:2, contextWaitMs:0, getTime:()=>tiledContentSeconds(current.view)
  });
  const overlay = new VideoOverlay(current.video, timeline, {
    getTime:()=>tiledContentSeconds(current.view), opacity:1-subtitleTransparency/100,
    above:current.overlay
  });
  const RadioSource = direct ? TrackFxContinuousSource : TrackFxSource;
  const source = new RadioSource(current.view, {
    client:radioClient, transcribe:requestAsr, isPaused:()=>current.video.paused, aheadSeconds:PREPARATION_LOOKAHEAD,
    onReset:()=>{queue.reset(); timeline.seek();},
    onStatus: s => {
      if (session !== current) return;
      if (current.radio?.usingRelay) return;
      if (current.radio) current.radio.needsCollector=current.sourceKind==='live'&&['FX_DRM','FX_ENCRYPTED','FX_FORMAT','FX_DECODE'].includes(s.errorCode);
      const all = [...store.cues.values()], ready = all.filter(c=>c.status==='ready').length;
      radioStatus.textContent = s.errorCode ? `TR · ${s.message}`
        : direct ? `TR · 中文 ${ready} 句 · 音频已送至前方 ${Number.isFinite(s.sentAhead) ? s.sentAhead.toFixed(0) : '—'} 秒`
        : `TR · 中文 ${ready}/${all.length} · 提前 ${Number.isFinite(s.ahead) ? s.ahead.toFixed(0) : '—'} 秒`;
      refreshControls();
    }
  });
  current.radio = {store,timeline,queue,overlay,source};
  waitWhenPrepared(source, current);
  radioStatus.textContent = 'TR · 正在读取 Track FX…';
  source.start(cues=>queue.ingestMany(cues));
}
function findVideo() {
  return Array.from(document.querySelectorAll('video')).filter(v => v.getBoundingClientRect().width > 150)
    .sort((a,b) => b.clientWidth*b.clientHeight-a.clientWidth*a.clientHeight)[0] || null;
}
function detach(notifyCollector = false) {
  if (!session) return;
  stopRadio(session, notifyCollector);
  session.source.stop(); session.queue.dispose(); session.overlay.dispose();
  session.video.removeEventListener('emptied', session.reset);
  session.video.removeEventListener('enterpictureinpicture', session.unsupported);
  document.removeEventListener('fullscreenchange', session.unsupported);
  session = null;
}
function setEnabled(value) {
  if (collectorMode) { if (!value) stopCollector(); return; }
  enabled = value; radioEnabled = value; detach(!value);
  showTranslationIssue(null);
  if (!value) status.textContent = '已关闭，恢复开启前的官方字幕状态';
  else attach();
  if (!value) radioStatus.textContent = 'TR及采访翻译已关闭';
  refreshControls();
}
function attach() {
  if (collectorMode || !enabled || session) return;
  const video = findVideo();
  if (!video) { status.textContent = '等待播放器…'; return; }
  const store = new CueStore(), timeline = new SubtitleTimeline(store, { suppress: cue =>
    session?.store === store && Boolean(session.radio && [...session.radio.store.cues.values()]
      .some(other => {
        const origin = session.radio.usingRelay ? relayClockOrigin(session.view) : 0;
        return other.status === 'ready' && Number.isFinite(origin)
          && sameSpeech(cue, {...other,start:other.start-origin,end:other.end-origin});
      }))
  });
  timeline.setEnabled(true);
  const view = pageWindow.document.querySelector('tiledmedia-view');
  const useTiled = Boolean(view?.associatedPlayer && view.contains(video));
  const sourceKind = useTiled ? view.currentContentTime?.eventType : 'native';
  if (useTiled && !['live', 'vod'].includes(sourceKind)) { status.textContent = '等待播放器确认直播或回放时间轴…'; return; }
  const queue = new TranslationQueue(store, requestTranslation, { getTime: () => useTiled ? tiledContentSeconds(view) : video.currentTime });
  const captions = new OfficialCaptionVisibility(() => Array.from(document.querySelectorAll('.tm-ui-subtitle-overlay')));
  let source;
  const overlay = new VideoOverlay(video, timeline, {
    opacity: 1 - subtitleTransparency / 100,
    style: subtitleStyle, position: subtitlePosition,
    onPositionSave: value => { subtitlePosition = value; GM_setValue('subtitlePosition', value); },
    getTime: () => useTiled ? tiledContentSeconds(view) : video.currentTime,
    // A verified empty interval is silence too. Revealing the site's layer in
    // tiny inter-cue gaps can briefly expose its previous/next English caption.
    onRender: state => { if (useTiled) captions.setHidden(Boolean(timeline.enabled && source?.validated &&
      (state.text || source.coversTime(tiledContentSeconds(view))))); }
  });
  const sourceOptions = {epoch:`${Date.now()}`, onReset: () => { queue.reset(); timeline.seek(); captions.restore(); }, onStatus: s => {
    if (timeline.enabled !== s.available) timeline.setEnabled(s.available);
    const failed = [...store.cues.values()].filter(c => c.status === 'failed').length;
    const ready = [...store.cues.values()].filter(c => c.status === 'ready').length;
    status.textContent = !s.available ? s.message || '未找到可读英文轨；请先在官网选择英文字幕'
      : `${s.kind === 'tiled-live' ? '直播分段已接入' : useTiled ? '回放分段已接入' : '原生轨道'} · 领先 ${s.ahead?.toFixed(1) ?? '—'} 秒 · 中文 ${ready}/${s.cueCount}${failed ? ` · ${failed} 条英文回退` : ''}`;
    if (!s.available) captions.restore();
    refreshControls();
  }};
  const TiledSource = view?.currentContentTime?.eventType === 'live' ? TiledMediaLiveSource : TiledMediaVodSource;
  source = useTiled ? new TiledSource(view, {...sourceOptions, aheadSeconds:PREPARATION_LOOKAHEAD,
    followLiveHead: () => !video.paused,
    getOfficialText: () => document.querySelector('.tm-ui-subtitle-overlay')?.textContent || '' }) : new TextTrackSource(video, {...sourceOptions,horizonSeconds:PREPARATION_LOOKAHEAD});
  const reset = () => { detach(); };
  const unsupported = () => {
    if (document.fullscreenElement === video || document.pictureInPictureElement === video) {
      setEnabled(false); status.textContent = '视频单独全屏/画中画：已恢复官方字幕。请使用网页播放器容器全屏。';
    }
  };
  session = {video,store,timeline,queue,overlay,source,reset,unsupported,sourceKind,view:useTiled?view:null,radio:null};
  waitWhenPrepared(source, session);
  video.addEventListener('emptied', reset); video.addEventListener('enterpictureinpicture', unsupported);
  document.addEventListener('fullscreenchange', unsupported);
  source.start(cues => queue.ingestMany(cues));
  startRadio(session);
  if (!useTiled) radioStatus.textContent = 'TR 需要 F1 TV 的 Track FX 音轨';
  if (!radioEnabled) radioStatus.textContent = 'TR及采访翻译已关闭';
  unsupported();
}
radioButton.addEventListener('click', () => {
  if (!enabled) return;
  radioEnabled = !radioEnabled;
  if (radioEnabled && session) startRadio(session);
  else stopRadio(session, true);
  if (!radioEnabled) radioStatus.textContent = 'TR / 采访字幕已关闭 · 解说翻译继续';
  refreshControls();
});
collectorButton.addEventListener('click', () => {
  if (collectorButton.disabled || !session?.view) return;
  const programmeId=programmeRelayId(session.view);
  if (!programmeId) {radioStatus.textContent='请先打开本场直播或开启回放模拟模式。';return;}
  if (collectorWindow && !collectorWindow.closed && collectorWindowProgrammeId===programmeId) {collectorWindow.focus();return;}
  const url=new URL(location.href);url.searchParams.delete('f1zh-commentary');url.searchParams.delete('f1zh-audio');url.searchParams.set('f1zh-capture','1');url.searchParams.set('action','play');
  collectorWindow=window.open(url.href,`f1zh-audio-${programmeId}`);
  collectorWindowProgrammeId=programmeId;
  if(!collectorWindow)radioStatus.textContent='请允许打开本场的采集标签页，再点击一次。';
});
playbackButton.addEventListener('click', async () => {
  if (playbackButton.disabled) return;
  playbackButton.disabled=true;
  playbackStatus.textContent=collectorMode?'正在准备 Track FX…':'正在调整观看位置…';
  try {
    if (collectorMode) await prepareCollectorPlayback();
    else {
      const view=pageWindow.document.querySelector('tiledmedia-view'), video=view?.querySelector('video');
      if (!video) throw Error('请先打开本场官方播放器');
      await seekLivePosition(view,LIVE_VIEW_DELAY_SECONDS,!video.paused);
    }
  } catch (error) { status.textContent=error.message || '操作未完成，请在官网播放器手动调整。'; }
  finally {playbackButton.disabled=false;refreshControls();}
});
button.addEventListener('click', () => {
  if (!enabled && !token) { status.textContent = '先点击下方“配对本机服务”，再开启中文字幕。'; return; }
  setEnabled(!enabled);
});
function pairService() {
  const value = prompt('从 http://127.0.0.1:3847 本机配置页复制配对码，粘贴到这里。不要填写 API 密钥。', '');
  if (value === null) return;
  if (!/^[a-f0-9]{64}$/.test(value.trim())) { status.textContent = '配对码格式不正确，请从本机配置页重新复制。'; return; }
  token = value.trim(); GM_setValue('localServiceToken', token); showTranslationIssue(null);
  // Failed cues are intentionally not retried automatically. Re-pairing is an
  // explicit recovery action, so rebuild the current subtitle queue here.
  if (collectorMode) status.textContent = '脚本配对已保存；采集扩展需在“配对设置”中单独配对。';
  else if (enabled) setEnabled(true);
  else status.textContent = '配对已保存，可以开启中文字幕。';
  refreshControls();
}
GM_registerMenuCommand('配对本机翻译服务', pairService);
pairButton.addEventListener('click', pairService);
const watcher = setInterval(() => {
  if (location.href !== currentPage) {
    currentPage = location.href; detach(true);
    if (collectorSession) stopCollector('页面已切换，请在新节目重新开始声音采集。');
  }
  if (collectorMode) {tickCollector();refreshControls();return;}
  if (session && (!session.video.isConnected || session.video !== findVideo())) detach();
  const view = pageWindow.document.querySelector('tiledmedia-view');
  const kind = view?.currentContentTime?.eventType;
  if (session && view?.associatedPlayer && view.contains(session.video) && ['live', 'vod'].includes(kind) && session.sourceKind !== kind) detach();
  attach();
  const origin=session?.view&&relayClockOrigin(session.view);
  if (session?.radio?.usingRelay && !session.radio.relay) connectProgrammeRelay(session);
  if(session?.radio?.relay&&Number.isFinite(origin))session.radio.relay.setViewerState({
    contentTime:tiledContentSeconds(session.view)+origin,paused:session.video.paused,enabled:enabled&&radioEnabled});
  refreshControls();
}, 1000);
window.addEventListener('pagehide', event => {
  if(collectorMode&&collectorSession)stopCollector('采集页已离开，请重新开始声音采集。');
  // BFCache preserves this document and JS state; its timers resume on return.
  if (event.persisted) return;
  clearInterval(watcher); detach(true); floatingControls.dispose(); panel.remove();
});
window.addEventListener('pageshow', event => {
  if (event.persisted) { floatingControls.refresh(); session?.source.poll(); session?.overlay.draw(); session?.radio?.source?.poll(); session?.radio?.overlay.draw(); refreshControls(); }
});
