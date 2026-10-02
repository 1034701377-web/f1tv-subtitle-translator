import { CueStore, TranslationQueue, SubtitleTimeline } from './core.js';
import { TextTrackSource } from './sources.js';
import { VideoOverlay, normalizeSubtitleStyle } from './overlay.js';
import { FloatingControls } from './floating-controls.js';
import { TiledMediaVodSource, tiledContentSeconds, OfficialCaptionVisibility } from './tiledmedia-source.js';
import { TiledMediaLiveSource } from './tiledmedia-live-source.js';
import { commentaryPreparation } from './preparation-state.js';

const SERVICE = 'http://127.0.0.1:3847';
const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
const PREPARATION_SECONDS = 45, PREPARATION_LOOKAHEAD = 60, LIVE_VIEW_DELAY_SECONDS = 50;
let token = GM_getValue('localServiceToken', '');
const savedTransparency = Number(GM_getValue('subtitleTransparency', 0));
let subtitleTransparency = Number.isFinite(savedTransparency) ? Math.max(0, Math.min(100, savedTransparency)) : 0;
let subtitleStyle = normalizeSubtitleStyle(GM_getValue('subtitleStyle', {}));
let subtitlePosition = GM_getValue('subtitlePosition', null);
let session = null, enabled = false, currentPage = location.href;

const panel = document.createElement('div');
panel.dataset.f1zh = 'controls';
panel.style.cssText = 'position:fixed;right:18px;top:18px;z-index:2147483647;';
const shadow = panel.attachShadow({mode:'open'});
shadow.innerHTML = `<style>
:host{all:initial}[hidden]{display:none!important}
section{box-sizing:border-box;color:#e6eff8;background:#14202ff2;border:1px solid #456079;border-radius:12px;padding:12px;font:12px/1.5 system-ui,"Microsoft YaHei",sans-serif;width:min(310px,calc(100vw - 16px));max-height:calc(100vh - 16px);overflow:auto;box-shadow:0 8px 28px #0004}
button{cursor:pointer;background:#243c4e;border:1px solid #587c92;border-radius:6px;color:#edf5ff;padding:8px 9px;font:inherit;transition:background .18s,border-color .18s,color .18s}
button:hover:enabled{background:#304e63;border-color:#81aec7}button:focus-visible{outline:2px solid #91d7f4;outline-offset:2px}
.switches{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}.switches button{white-space:nowrap}button:disabled{cursor:default;color:#889eaf;background:#1c2b3b;border-color:#394f61}
#toggle[aria-pressed=true]{border-color:#83bcd5;background:#294b60}
#preparation{display:block;width:100%;letter-spacing:.12em;font-weight:600;background:#1b2b3b;color:#9dafbe;border-color:#3e5366;padding:9px;cursor:default}
#preparation[data-state=preparing]{color:#a9d9ee;border-color:#608da5;background:#203a4b}
#preparation[data-state=ready]{color:#14202f;background:#83dfc7;border-color:#83dfc7;box-shadow:0 0 18px #83dfc718}
#preparation-detail,#playback-status{color:#a1b4c5;font-size:11px;margin:6px 0 11px;font-variant-numeric:tabular-nums}
p{margin:4px 0;overflow-wrap:anywhere}#status{color:#b9cbd9;font-size:11px}small{color:#90a5b7}a{color:#9edbf4}
.opacity,.style-option{display:flex;align-items:center;gap:8px;margin:8px 0}input[type=range]{flex:1;min-width:0;accent-color:#82c7ed}output{min-width:4ch;text-align:right;font-variant-numeric:tabular-nums}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:-2px 0 12px;cursor:grab;touch-action:none;user-select:none}header span{color:#d8e6f1;font-weight:600}header small{font-weight:400;margin-left:7px}
#minimize{margin:0;padding:0;width:28px;height:26px;font-size:18px;line-height:1}
#ball{display:grid;place-items:center;box-sizing:border-box;width:40px;height:40px;margin:0;padding:0;border-radius:50%;background:#14202feb;border:1px solid #648ba5;box-shadow:0 2px 8px #0005;font:600 15px system-ui,"Microsoft YaHei",sans-serif;cursor:grab;touch-action:none;user-select:none}
:host([data-dragging]) header,:host([data-dragging]) #ball{cursor:grabbing}
details{margin:4px 0 8px;border-top:1px solid #456079;padding-top:6px}summary{cursor:pointer;user-select:none}.style-option select{flex:1;min-width:0;background:#243c4e;color:#fff;border:1px solid #587c92;border-radius:4px;font:inherit;padding:3px}
#prepare-playback{width:100%;margin-top:8px}#issue{color:#ffd38a}
</style><section id="console">
<header id="drag-handle" title="拖动标题栏移动控制台"><span>字幕翻译<small>拖动移动</small></span><button id="minimize" aria-label="最小化控制台" title="最小化为悬浮球">−</button></header>
<div class="switches"><button id="toggle" aria-pressed="false">开启翻译</button><button id="pair">配对本机服务</button></div>
<button id="preparation" data-state="waiting" disabled aria-live="polite">等待中</button>
<p id="preparation-detail">开启后，先准备至少 45 秒解说中文</p>
<details><summary>字幕样式</summary>
<label class="style-option" for="subtitle-font">字体<select id="subtitle-font"><option value="yahei">微软雅黑</option><option value="heiti">黑体</option><option value="songti">宋体</option><option value="system">系统默认</option></select></label>
<label class="style-option" for="subtitle-size">字号<input id="subtitle-size" type="range" min="16" max="48" step="1"><output id="subtitle-size-value"></output></label>
<label class="style-option"><input id="subtitle-bold" type="checkbox">加粗</label>
<label class="opacity" for="transparency">透明度<input id="transparency" type="range" min="0" max="100" step="5"><output id="transparency-value"></output></label>
<small>拖动字幕可移动；样式自动保存。</small></details>
<p id="status">翻译已关闭</p><p id="issue" hidden role="status"></p>
<button id="prepare-playback" hidden title="调整到直播后方 50 秒；保留当前暂停或播放状态">预留 50 秒翻译时间</button>
<p id="playback-status"></p><small><a href="${SERVICE}/" target="_blank" rel="noopener noreferrer">本机配置页</a></small>
</section><button id="ball" hidden aria-label="展开字幕控制台" title="点击展开；拖动后吸附左右边缘">中</button>`;
document.body.append(panel);
panel.addEventListener('keydown', event => event.stopPropagation());
panel.addEventListener('keyup', event => event.stopPropagation());
const button = shadow.getElementById('toggle'), status = shadow.getElementById('status');
const preparationButton = shadow.getElementById('preparation'), preparationDetail = shadow.getElementById('preparation-detail');
const playbackButton = shadow.getElementById('prepare-playback'), playbackStatus = shadow.getElementById('playback-status');
const translationIssue = shadow.getElementById('issue');
const translationMessages = {
  NOT_CONFIGURED:'请在本机配置页保存自己的 API 密钥，然后重新开启翻译。',
  UNAUTHORIZED:'配对已失效，请从本机配置页复制新的配对码。',
  LOCAL_SERVICE_UNAVAILABLE:'无法连接本机服务，请先运行 start-service.cmd。',
  LOCAL_SERVICE_TIMEOUT:'本机请求超时，当前句保留英文。',
  BUSY:'翻译队列繁忙，当前句保留英文。',
  UPSTREAM_AUTH_FAILED:'API 认证失败，请检查本机配置页中的密钥。',
  UPSTREAM_BALANCE:'API 余额不足。',
  UPSTREAM_RATE_LIMITED:'API 限流，当前句保留英文；稍后关闭再开启翻译重试。',
  UPSTREAM_UNAVAILABLE:'无法连接翻译 API，请检查网络与配置。',
  UPSTREAM_REJECTED:'API 拒绝请求，请检查接口和模型名称。',
  TRANSLATION_TIMEOUT:'API 响应超时，当前句保留英文。',
  INVALID_UPSTREAM_RESPONSE:'API 未返回有效译文，当前句保留英文。'
};
function showTranslationIssue(code) {
  translationIssue.textContent = code ? translationMessages[code] || '翻译请求失败，当前句保留英文。' : '';
  translationIssue.hidden = !code;
}
const fontControl = shadow.getElementById('subtitle-font'), sizeControl = shadow.getElementById('subtitle-size');
const boldControl = shadow.getElementById('subtitle-bold'), sizeValue = shadow.getElementById('subtitle-size-value');
fontControl.value = subtitleStyle.font; sizeControl.value = String(subtitleStyle.size); boldControl.checked = subtitleStyle.bold;
sizeValue.value = `${subtitleStyle.size}px`;
for (const control of [fontControl, sizeControl, boldControl]) {
  control.addEventListener('input', () => {
    subtitleStyle = normalizeSubtitleStyle({font:fontControl.value, size:Number(sizeControl.value), bold:boldControl.checked});
    sizeValue.value = `${subtitleStyle.size}px`; session?.overlay.setStyle(subtitleStyle);
  });
  control.addEventListener('change', () => GM_setValue('subtitleStyle', subtitleStyle));
}
const transparency = shadow.getElementById('transparency'), transparencyValue = shadow.getElementById('transparency-value');
transparency.value = String(subtitleTransparency); transparencyValue.value = `${subtitleTransparency}%`;
transparency.addEventListener('input', () => {
  subtitleTransparency = Number(transparency.value); transparencyValue.value = `${subtitleTransparency}%`;
  session?.overlay.setOpacity(1 - subtitleTransparency / 100);
});
transparency.addEventListener('change', () => GM_setValue('subtitleTransparency', subtitleTransparency));
const floatingControls = new FloatingControls(panel, {
  panel:shadow.getElementById('console'), handle:shadow.getElementById('drag-handle'),
  minimize:shadow.getElementById('minimize'), ball:shadow.getElementById('ball'),
  saved:GM_getValue('floatingConsole', null), onSave:value => GM_setValue('floatingConsole', value)
});

function preparationFor(current = session) {
  const time = current?.view ? tiledContentSeconds(current.view) : current?.video.currentTime;
  const source = current?.source, cues = current ? current.store.sorted() : [];
  const coverage = current?.sourceKind === 'native' ? cues.map(c => [c.start, c.end])
    : !source?.validated ? [] : source.coverage || [[source.coverageStart, source.coverageEnd]];
  return commentaryPreparation({enabled, time, coverage, cues, targetSeconds:PREPARATION_SECONDS});
}
function behindLiveSeconds(view) {
  const clock = view?.currentContentTime;
  return clock?.eventType === 'live' && Number.isFinite(clock.seekUpperBound) && Number.isFinite(clock.currentPosition)
    ? Math.max(0, (clock.seekUpperBound - clock.currentPosition) / 1000) : NaN;
}
function refreshControls() {
  button.textContent = enabled ? '关闭翻译' : '开启翻译'; button.setAttribute('aria-pressed', String(enabled));
  shadow.getElementById('pair').textContent = token ? '重新配对' : '配对本机服务';
  const prep = preparationFor();
  preparationButton.dataset.state = prep.state;
  preparationButton.textContent = {waiting:'等待中', preparing:'准备中', ready:'准备就绪'}[prep.state];
  preparationDetail.textContent = !enabled ? '开启后，先准备至少 45 秒解说中文'
    : !session ? '等待播放器，解说中文目标 45 秒'
    : prep.state === 'ready' ? `解说中文已连续准备 ${Math.floor(prep.ahead)} 秒${session.video.paused ? ' · 可以开始播放' : ''}`
    : `解说中文连续就绪 ${Math.floor(prep.ahead)} / 45 秒${session.video.paused ? '' : ' · 播放中继续准备'}`;
  const view = pageWindow.document.querySelector('tiledmedia-view'), lag = behindLiveSeconds(view);
  playbackButton.hidden = !Number.isFinite(lag);
  if (!playbackButton.disabled) playbackStatus.textContent = Number.isFinite(lag) ? `当前落后官方直播前沿约 ${Math.round(lag)} 秒` : '';
}
function waitWhenPrepared(source, current) {
  const poll = source.poll.bind(source);
  source.poll = () => {
    if (session !== current || !enabled) return;
    if (current.video.paused && preparationFor(current).state === 'ready') return;
    return poll();
  };
}
function requestTranslation(cue, context, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(Error('cancelled'));
    let finished = false, request;
    const done = (error, value) => {
      if (finished) return;
      finished = true; signal.removeEventListener('abort', abort);
      if (error !== 'CANCELLED') showTranslationIssue(error);
      error ? reject(Error('translation_unavailable')) : resolve(value);
    };
    const abort = () => {request?.abort(); done('CANCELLED');};
    signal.addEventListener('abort', abort, {once:true});
    try {request = GM_xmlhttpRequest({method:'POST', url:`${SERVICE}/api/translate`, anonymous:true,
      headers:{'Content-Type':'application/json', Authorization:`Bearer ${token}`},
      data:JSON.stringify({cue,context}), timeout:11500,
      onload:response => {
        let body;
        try {body = JSON.parse(response.responseText);} catch {return done('INVALID_UPSTREAM_RESPONSE');}
        if (response.status !== 200) return done(response.status === 401 ? 'UNAUTHORIZED' : body?.error?.code || 'REQUEST_FAILED');
        if (typeof body?.text !== 'string' || !body.text.trim()) return done('INVALID_UPSTREAM_RESPONSE');
        done(null, body);
      }, onerror:()=>done('LOCAL_SERVICE_UNAVAILABLE'), ontimeout:()=>done('LOCAL_SERVICE_TIMEOUT'), onabort:()=>done('CANCELLED')
    });} catch {done('LOCAL_SERVICE_UNAVAILABLE');}
  });
}
function findVideo() {
  return Array.from(document.querySelectorAll('video')).filter(v => v.getBoundingClientRect().width > 150)
    .sort((a,b) => b.clientWidth*b.clientHeight - a.clientWidth*a.clientHeight)[0] || null;
}
function detach() {
  if (!session) return;
  session.source.stop(); session.queue.dispose(); session.overlay.dispose(); session.captions.restore();
  session.video.removeEventListener('emptied', session.reset);
  session.video.removeEventListener('enterpictureinpicture', session.unsupported);
  document.removeEventListener('fullscreenchange', session.unsupported); session = null;
}
function setEnabled(value) {
  enabled = value; detach(); showTranslationIssue(null);
  if (!value) status.textContent = '已关闭，恢复官方字幕'; else attach();
  refreshControls();
}
function attach() {
  if (!enabled || session) return;
  const video = findVideo();
  if (!video) {status.textContent = '等待播放器…'; return;}
  const view = pageWindow.document.querySelector('tiledmedia-view');
  const useTiled = Boolean(view?.associatedPlayer && view.contains(video));
  const sourceKind = useTiled ? view.currentContentTime?.eventType : 'native';
  if (useTiled && !['live','vod'].includes(sourceKind)) {status.textContent = '等待播放器时间轴…'; return;}
  const getTime = () => useTiled ? tiledContentSeconds(view) : video.currentTime;
  const store = new CueStore(), timeline = new SubtitleTimeline(store);
  timeline.setEnabled(true);
  const queue = new TranslationQueue(store, requestTranslation, {getTime});
  const captions = new OfficialCaptionVisibility(() => Array.from(document.querySelectorAll('.tm-ui-subtitle-overlay')));
  let source;
  const overlay = new VideoOverlay(video, timeline, {
    opacity:1 - subtitleTransparency / 100, style:subtitleStyle, position:subtitlePosition, getTime,
    onPositionSave:value => {subtitlePosition = value; GM_setValue('subtitlePosition', value);},
    onRender:state => {if (useTiled) captions.setHidden(Boolean(timeline.enabled && source?.validated && (state.text || source.coversTime(getTime()))));}
  });
  const sourceOptions = {epoch:`${Date.now()}`, onReset:() => {queue.reset(); timeline.seek(); captions.restore();}, onStatus:s => {
    if (timeline.enabled !== s.available) timeline.setEnabled(s.available);
    const all = [...store.cues.values()], failed = all.filter(c => c.status === 'failed').length;
    const ready = all.filter(c => c.status === 'ready').length;
    status.textContent = !s.available ? s.message || '请先在官网选择 English 字幕'
      : `${s.kind === 'tiled-live' ? '直播' : '回放'}解说字幕已接入 · 中文 ${ready}/${all.length}${failed ? ` · ${failed} 句保留英文` : ''}`;
    if (!s.available) captions.restore(); refreshControls();
  }};
  const TiledSource = sourceKind === 'live' ? TiledMediaLiveSource : TiledMediaVodSource;
  source = useTiled ? new TiledSource(view, {...sourceOptions, aheadSeconds:PREPARATION_LOOKAHEAD,
    followLiveHead:() => !video.paused, getOfficialText:() => document.querySelector('.tm-ui-subtitle-overlay')?.textContent || ''})
    : new TextTrackSource(video, {...sourceOptions, horizonSeconds:PREPARATION_LOOKAHEAD});
  const reset = () => detach();
  const unsupported = () => {
    if (document.fullscreenElement === video || document.pictureInPictureElement === video) {
      setEnabled(false); status.textContent = '请使用网页播放器的全屏按钮；单独视频全屏和画中画已恢复官方字幕。';
    }
  };
  session = {video,view:useTiled ? view : null,store,timeline,queue,overlay,source,captions,reset,unsupported,sourceKind};
  waitWhenPrepared(source, session);
  video.addEventListener('emptied', reset); video.addEventListener('enterpictureinpicture', unsupported);
  document.addEventListener('fullscreenchange', unsupported);
  source.start(cues => queue.ingestMany(cues)); unsupported();
}
function pairService() {
  const value = prompt('从 http://127.0.0.1:3847 点击“复制配对码”，粘贴到这里。这里不需要 API 密钥。', '');
  if (value === null) return;
  if (!/^[a-f0-9]{64}$/.test(value.trim())) {status.textContent = '配对码格式不正确，请重新复制。'; return;}
  token = value.trim(); GM_setValue('localServiceToken', token); showTranslationIssue(null);
  if (enabled) setEnabled(true); else status.textContent = '已配对，点击开启翻译';
  refreshControls();
}
GM_registerMenuCommand('配对本机翻译服务', pairService);
shadow.getElementById('pair').addEventListener('click', pairService);
button.addEventListener('click', () => {if (!enabled && !token) {pairService(); return;} setEnabled(!enabled);});
playbackButton.addEventListener('click', async () => {
  if (playbackButton.disabled) return;
  playbackButton.disabled = true; playbackStatus.textContent = '正在预留翻译时间…';
  try {
    const view = pageWindow.document.querySelector('tiledmedia-view'), video = view?.querySelector('video');
    const clock = view?.currentContentTime, player = view?.associatedPlayer;
    if (!video || !player || clock?.eventType !== 'live' || !Number.isFinite(clock.seekUpperBound)
        || !Number.isFinite(clock.seekLowerBound) || !pageWindow.Tiledmedia?.TimingConfig) throw Error('请先打开官网直播，等待时间轴就绪');
    const target = clock.seekUpperBound - LIVE_VIEW_DELAY_SECONDS * 1000, resume = !video.paused;
    if (target < clock.seekLowerBound) throw Error('直播可回看范围暂时不足，请稍后再试');
    const config = new pageWindow.Tiledmedia.TimingConfig();
    config.timingType = 1; config.targetPositionStrategy = 1; config.target = target;
    await player.seek(config);
    if (view.isConnected && view.associatedPlayer === player) {if (resume) await player.unpause(); else await player.pause();}
  } catch (error) {status.textContent = error.message || '请在官网播放器手动调到直播后方约 50 秒。';}
  finally {playbackButton.disabled = false; refreshControls();}
});
refreshControls();
const watcher = setInterval(() => {
  if (location.href !== currentPage) {currentPage = location.href; detach();}
  if (session && (!session.video.isConnected || session.video !== findVideo())) detach();
  const view = pageWindow.document.querySelector('tiledmedia-view'), kind = view?.currentContentTime?.eventType;
  if (session && view?.associatedPlayer && view.contains(session.video) && ['live','vod'].includes(kind) && session.sourceKind !== kind) detach();
  attach(); refreshControls();
}, 1000);
window.addEventListener('pagehide', event => {
  if (event.persisted) return;
  clearInterval(watcher); detach(); floatingControls.dispose(); panel.remove();
});
window.addEventListener('pageshow', event => {
  if (event.persisted) {floatingControls.refresh(); session?.source.poll(); session?.overlay.draw(); refreshControls();}
});
