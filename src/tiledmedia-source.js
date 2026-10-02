import { parseHlsVodPlaylist, parseWebVtt } from './hls-vtt.js';

const normalizedCaption = value => String(value || '').replace(/\s+/g, ' ').trim();

// The SDK's content position (ms) is the programme clock. The child <video>
// uses a rebased MSE clock and MUST NOT be substituted for it.
export function tiledContentSeconds(view) {
  const time = view?.currentContentTime;
  return time && Number.isFinite(time.currentPosition) ? time.currentPosition / 1000 : NaN;
}

export class TiledMediaVodSource {
  constructor(view, { aheadSeconds = 45, fetchText, onStatus = () => {}, onReset = () => {}, getOfficialText = () => '' } = {}) {
    this.view = view; this.aheadSeconds = aheadSeconds; this.onStatus = onStatus; this.onReset = onReset;
    this.getOfficialText = getOfficialText;
    this.fetchText = fetchText || (async (url, signal) => {
      const response = await fetch(url, { signal, credentials: 'omit', redirect: 'error' });
      if (!response.ok) throw Error('字幕文件请求失败');
      const text = await response.text();
      if (text.length > 2000000) throw Error('字幕文件超出大小限制');
      return text;
    });
    this.cache = new Map(); this.seen = new Set(); this.epoch = 0; this.validated = false;
    this.coverageStart = NaN; this.coverageEnd = NaN;
    this.onCues = () => {}; this.stopped = true; this.busy = false; this.url = null;
  }
  start(onCues) { this.onCues = onCues; this.stopped = false; this.poll(); this.timer = setInterval(() => this.poll(), 1000); }
  coversTime(time) {
    return !this.stopped && this.validated && Number.isFinite(time) && time >= this.coverageStart && time < this.coverageEnd;
  }
  reset() {
    this.cache.clear(); this.seen.clear(); this.playlist = null; this.url = null;
    this.coverageStart = NaN; this.coverageEnd = NaN;
    this.validated = false; this.epoch++; this.onReset();
  }
  async poll() {
    if (this.stopped || this.busy) return;
    this.busy = true;
    const controller = new AbortController(); this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const clock = this.view.currentContentTime;
      if (clock?.eventType !== 'vod') throw Error('当前只验证了回放字幕，直播时间映射尚待验证');
      const player = this.view.associatedPlayer;
      const stream = player?.currentSubtitleTrack;
      if (!stream || player.desiredSubtitleTrackSelection?.disable) throw Error('请先在官网字幕菜单选择英文');
      const track = await stream.parentSubtitleTrack;
      const language = await track.language;
      if (!/^en(?:g)?(?:-|$)/i.test(language || '')) throw Error('请先在官网字幕菜单选择英文');
      const url = await stream.url;
      const parsedUrl = new URL(url);
      // Signed URLs remain in this browser session only. Never send them to the
      // translation server, console, persisted config, or error messages.
      if (parsedUrl.protocol !== 'https:' || !/(^|\.)formula1\.com$/i.test(parsedUrl.hostname)) throw Error('字幕资源不属于已验证的官方域名');
      if (this.stopped) return;
      if (url !== this.url) { this.reset(); this.url = url; }
      if (!this.playlist) {
        this.playlist = parseHlsVodPlaylist(await this.fetchText(url, controller.signal), url);
        if (!Number.isFinite(clock.contentDuration) || Math.abs(this.playlist.duration - clock.contentDuration / 1000) > 1) {
          this.playlist = null; throw Error('字幕清单时长与节目时钟不匹配');
        }
      }
      const time = tiledContentSeconds(this.view);
      const wanted = this.playlist.segments.filter(s => s.end >= Math.max(0, time - 6) && s.start <= time + this.aheadSeconds);
      // Fetch a small playback neighbourhood, never translate an entire race on
      // enable. Acquisition is independent of video playback events.
      for (const segment of wanted) {
        if (this.stopped) return;
        if (!this.cache.has(segment.sequence)) {
          this.cache.set(segment.sequence, parseWebVtt(await this.fetchText(segment.url, controller.signal), {epoch:`tiled-${this.epoch}`}));
        }
      }
      if (this.stopped) return;
      const available = [...new Map(wanted.flatMap(s => this.cache.get(s.sequence) || []).map(c => [c.id,c])).values()];
      const now = tiledContentSeconds(this.view);
      if (!this.validated) {
        const official = normalizedCaption(this.getOfficialText());
        const current = available.filter(c => c.start <= now && now < c.end).map(c=>normalizedCaption(c.text));
        this.validated = Boolean(official && current.some(text => text === official || current.join(' ') === official));
      }
      if (!this.validated) {
        this.onStatus({available:false, message:'已读到字幕分段，等待当前官方英文与节目时间吻合以校准'}); return;
      }
      const batch = available.filter(c => c.end >= now - 6 && !this.seen.has(c.id));
      batch.forEach(c => this.seen.add(c.id));
      if (batch.length) this.onCues(batch);
      // Commit coverage only after delivering cues; real gaps in these fully
      // read segments are also covered, even if the official layer lingers.
      this.coverageStart = wanted.length ? Math.max(wanted[0].start, now - 6) : NaN;
      this.coverageEnd = wanted.at(-1)?.end ?? NaN;
      const end = available.reduce((max,c)=>Math.max(max,c.end),now);
      this.onStatus({available:true, cueCount:this.seen.size, ahead:end-now, contentTime:now, kind:'tiled-vod'});
      // Bound raw segment memory; translated cue cache is maintained separately.
      if (this.cache.size > 160) {
        const keep = new Set(wanted.map(s=>s.sequence));
        for (const key of this.cache.keys()) { if (!keep.has(key)) this.cache.delete(key); if(this.cache.size <= 100) break; }
      }
    } catch (error) {
      this.validated = false;
      if (!this.stopped) this.onStatus({available:false, message:controller.signal.aborted ? '字幕读取超时，保留官方字幕' : '字幕读取或校准失败；请确认官网英文已开启、当前为回放且可播放'});
    } finally { clearTimeout(timeout); this.busy = false; }
  }
  stop() { this.stopped = true; clearInterval(this.timer); this.controller?.abort(); this.cache.clear(); this.seen.clear(); }
}

// The caller decides when its subtitle coverage should hide the official layer,
// including known gaps between cues. Restoring preserves the original styles.
export class OfficialCaptionVisibility {
  constructor(findElements) { this.findElements = findElements; this.original = new Map(); }
  setHidden(hidden) {
    if (!hidden) { this.restore(); return; }
    for (const element of this.findElements()) {
      if (!this.original.has(element)) this.original.set(element, [element.style.getPropertyValue('visibility'),element.style.getPropertyPriority('visibility')]);
      element.style.setProperty('visibility','hidden','important');
    }
  }
  restore() {
    for (const [element,[value,priority]] of this.original) {
      if (value) element.style.setProperty('visibility',value,priority); else element.style.removeProperty('visibility');
    }
    this.original.clear();
  }
}
