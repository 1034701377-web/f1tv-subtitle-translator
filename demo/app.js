import { CueStore, TranslationQueue, SubtitleTimeline } from '/src/core.js';
import { SimulatedSource } from '/demo/simulated-source.js';
import { VideoOverlay } from '/src/overlay.js';
import { fixture, translations } from '/demo/fixture.js';

const $ = id => document.getElementById(id);
const video = $('video');
$('mode').textContent = '本地模拟 · 不调用任何 API';
const native = video.addTextTrack('subtitles', 'English (test)', 'en');
fixture.forEach(c => native.addCue(new VTTCue(c.start, c.end, c.text)));
native.mode = 'hidden';
const store = new CueStore();
const timeline = new SubtitleTimeline(store);
timeline.setEnabled(true);
const overlay = new VideoOverlay(video, timeline);
let enabled = true, source, queue;
const format = time => `${Math.floor(time / 60).toString().padStart(2, '0')}:${(time % 60).toFixed(1).padStart(4, '0')}`;

function restart() {
  video.pause(); video.currentTime = 0; timeline.seek();
  source?.stop(); queue?.dispose(); store.clear();
  const scenario = $('scenario').value;
  queue = new TranslationQueue(store, async (cue, context, signal) => {
    const wait = cue.id === 'demo-2' && scenario === 'slow' ? 8000
      : cue.id === 'demo-2' && scenario === 'timeout' ? 15000 : 300;
    await new Promise((resolve, reject) => {
      if (signal.aborted) return reject(Error('cancelled'));
      const cancel = () => { clearTimeout(timer); reject(Error('cancelled')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, wait);
      signal.addEventListener('abort', cancel, {once:true});
    });
    if (cue.id === 'demo-3' && scenario === 'fail') throw Error('simulated failure');
    return {text:translations[cue.text]};
  }, { getTime: () => video.currentTime });
  source = new SimulatedSource(fixture, { leadSeconds: Math.max(0, Math.min(60, Number($('lead').value) || 0)) });
  source.start(cues => queue.ingestMany(cues));
  update();
}
const rows = new Map();
for (const cue of fixture) {
  const tr = document.createElement('tr'); tr.dataset.cueId = cue.id;
  const time = document.createElement('td'); const button = document.createElement('button');
  button.className = 'seek'; button.textContent = `${format(cue.start)}–${format(cue.end)}`;
  button.addEventListener('click', () => { video.currentTime = cue.start + .1; }); time.append(button);
  const text = document.createElement('td'); const en = document.createElement('div'); en.className = 'en'; en.textContent = cue.text;
  const zh = document.createElement('div'); zh.className = 'zh'; text.append(en, zh);
  const status = document.createElement('td'); tr.append(time, text, status); $('cues').append(tr);
  rows.set(cue.id, { tr, zh, status });
}
function update() {
  const time = video.currentTime;
  $('screen-time').textContent = format(time); $('watch-time').textContent = `${time.toFixed(1)} s`;
  $('play-state').textContent = video.paused ? '已暂停 · 采集仍继续' : '正在播放';
  $('source-time').textContent = `${source?.head.toFixed(1) || 0} s`;
  const all = store.sorted(); const end = all.length ? Math.max(...all.map(c => c.end)) : null;
  $('ahead').textContent = end === null ? '—' : `${(end - time).toFixed(1)} s`;
  $('acquired').textContent = end === null ? '等待字幕' : `已取得至 ${format(end)} · ${all.length} 条`;
  $('ready').textContent = `${all.filter(c => c.status === 'ready').length} 条`;
  $('queue-state').textContent = `进行中 ${all.filter(c => c.status === 'pending').length} · 失败 ${all.filter(c => c.status === 'failed').length}`;
  for (const cue of fixture) {
    const row = rows.get(cue.id), cached = store.cues.get(cue.id);
    row.tr.classList.toggle('active', time >= cue.start && time < cue.end);
    row.zh.textContent = cached?.zh || (cached?.status === 'failed' ? '本次未取得中文，播放时保留英文。' : '');
    row.status.className = `state-${cached?.status || 'waiting'}`;
    row.status.textContent = ({ready:'已就绪',queued:'排队中',pending:'翻译中',failed:'英文回退'})[cached?.status] || '尚未到达';
  }
}
$('toggle').addEventListener('click', () => {
  enabled = !enabled; timeline.setEnabled(enabled); native.mode = enabled ? 'hidden' : 'showing';
  $('toggle').textContent = enabled ? '中文已开启' : '官方英文'; $('toggle').setAttribute('aria-pressed', String(enabled));
  overlay.draw();
});
$('rewind').addEventListener('click', () => { video.currentTime = Math.max(0, video.currentTime - 10); });
$('fullscreen').addEventListener('click', () => $('stage').requestFullscreen());
// Native video-only fullscreen / PiP cannot contain an HTML subtitle layer.
const unsupportedDisplay = () => {
  if (document.fullscreenElement === video || document.pictureInPictureElement === video) {
    if (enabled) $('toggle').click();
    $('hint').textContent = '视频单独全屏 / 画中画已恢复英文。请退出后开启中文，并使用“画面全屏”。';
  }
};
document.addEventListener('fullscreenchange', unsupportedDisplay); video.addEventListener('enterpictureinpicture', unsupportedDisplay);
$('restart').addEventListener('click', restart);
restart(); setInterval(update, 150);
window.addEventListener('pagehide', event => {
  if (event.persisted) return;
  source.stop(); queue.dispose(); overlay.dispose();
});
window.addEventListener('pageshow', event => {
  if (event.persisted) { source.poll(); overlay.draw(); update(); }
});

// Expose the local fixture for developer checks without touching an F1 page.
export { overlay };
